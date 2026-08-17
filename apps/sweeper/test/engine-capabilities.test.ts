import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  engineArchiveReductionVersion,
  engineMeshRecoveryVersion,
  engineUransRecoveryVersion,
  supportsArchiveCleanCycleReduction,
  supportsCurrentArchiveCleanCycleReduction,
  supportsDurableUransRecovery,
} from "../src/engine-capabilities";
import { drainArchiveReductionQueue } from "../src/archive-reduction-queue";
import {
  remoteAdmissionDecisionForTick,
  schedulerReconcileOptions,
  submitOneBatch,
} from "../src/loop";
import {
  submitExactUransCanaryStep,
  uransLadderTick,
} from "../src/urans-ladder";

describe("engine mesh-recovery capability handshake", () => {
  it("MUST-CATCH: scheduler reconciliation records routes but cannot submit replacement CFD before admission gates", () => {
    expect(schedulerReconcileOptions()).toEqual({ recordRoutesOnly: true });
    expect(
      schedulerReconcileOptions({
        jobIds: ["11111111-1111-4111-8111-111111111111"],
        recoverFailedJobIds: ["22222222-2222-4222-8222-222222222222"],
        skipFailedRecovery: true,
        recordRoutesOnly: false,
      }),
    ).toEqual({
      jobIds: ["11111111-1111-4111-8111-111111111111"],
      recoverFailedJobIds: ["22222222-2222-4222-8222-222222222222"],
      skipFailedRecovery: true,
      recordRoutesOnly: true,
    });
  });

  it("MUST-CATCH: disk-blocked scheduler cleanup runs before saturated-engine reconciliation", () => {
    const loopSource = readFileSync(
      fileURLToPath(new URL("../src/loop.ts", import.meta.url)),
      "utf8",
    );
    const tickStart = loopSource.indexOf("export async function tick(");
    const earlyReclaim = loopSource.indexOf(
      "await deleteDiscardedTerminalRemoteJobDirs(",
      tickStart,
    );
    const reconcile = loopSource.indexOf("await reconcile(", tickStart);

    expect(tickStart).toBeGreaterThanOrEqual(0);
    expect(earlyReclaim).toBeGreaterThan(tickStart);
    expect(reconcile).toBeGreaterThan(earlyReclaim);
  });

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

  it("holds ordinary RANS admission when immutable archive reduction is not available", async () => {
    let submissions = 0;
    const engine = {
      submitPolar: async () => {
        submissions += 1;
        throw new Error("legacy archive reducer must not reach the engine");
      },
    } as unknown as EngineClient;
    await expect(submitOneBatch({} as DB, engine, 0, 0, 0)).resolves.toBe(
      false,
    );
    expect(submissions).toBe(0);
  });

  it("holds ordinary RANS admission on a legacy reducer before submit", async () => {
    let submissions = 0;
    const engine = {
      submitPolar: async () => {
        submissions += 1;
        throw new Error("legacy reducer must not receive a physical request");
      },
    } as unknown as EngineClient;
    await expect(submitOneBatch({} as DB, engine, 0, 0, 3)).resolves.toBe(
      false,
    );
    expect(submissions).toBe(0);
  });
});

describe("engine immutable archive-reduction capability handshake", () => {
  it("accepts the explicit first clean-cycle reducer contract", async () => {
    const engine = {
      healthDetails: async () => ({
        status: "ok",
        version: "archive-reducer-v1",
        archive_reduction_version: 1,
      }),
    } as unknown as EngineClient;
    await expect(engineArchiveReductionVersion(engine)).resolves.toBe(1);
    expect(supportsArchiveCleanCycleReduction(1)).toBe(true);
    expect(supportsCurrentArchiveCleanCycleReduction(1)).toBe(false);
  });

  it("admits only the current archive reducer for new physical work", () => {
    expect(supportsCurrentArchiveCleanCycleReduction(3)).toBe(false);
    expect(supportsCurrentArchiveCleanCycleReduction(4)).toBe(true);
    expect(supportsCurrentArchiveCleanCycleReduction(5)).toBe(false);
  });

  it("treats a health response without an explicit reducer as legacy and closes new work", async () => {
    const engine = {
      healthDetails: async () => ({ status: "ok", version: "legacy-2406" }),
    } as unknown as EngineClient;
    await expect(engineArchiveReductionVersion(engine)).resolves.toBe(0);
    expect(supportsArchiveCleanCycleReduction(0)).toBe(false);
    expect(supportsArchiveCleanCycleReduction(null)).toBe(false);
  });

  it.each([-1, 1.5, Number.NaN, "1", null, 2_147_483_648])(
    "fails closed on malformed archive-reducer version %p",
    async (archiveReductionVersion) => {
      const engine = {
        healthDetails: async () => ({
          status: "ok",
          version: "malformed",
          archive_reduction_version: archiveReductionVersion,
        }),
      } as unknown as EngineClient;
      await expect(engineArchiveReductionVersion(engine)).resolves.toBeNull();
    },
  );

  it("leaves direct archive-reduction queue work pending when the engine is legacy", async () => {
    let reductions = 0;
    const engine = {
      healthDetails: async () => ({ status: "ok", version: "legacy-2406" }),
      reduceRemoteEvidenceCleanCycles: async () => {
        reductions += 1;
        throw new Error("a legacy engine must not receive archive reduction");
      },
    } as unknown as EngineClient;

    await expect(
      drainArchiveReductionQueue({} as DB, engine, { enqueue: false }),
    ).resolves.toMatchObject({
      scanned: 0,
      enqueued: 0,
      processed: 0,
      archiveReductionVersion: 0,
      deferredByCapability: true,
    });
    expect(reductions).toBe(0);
  });

  it("holds direct ladder and canary entry points before they touch durable state", async () => {
    let submissions = 0;
    const legacyCanaryEngine = {
      healthDetails: async () => ({ status: "ok", version: "legacy-2406" }),
      submitPolar: async () => {
        submissions += 1;
        throw new Error("a legacy engine must not receive a physical request");
      },
    } as unknown as EngineClient;

    await expect(
      uransLadderTick({} as DB, legacyCanaryEngine, 0, {
        archiveReductionVersion: 0,
      }),
    ).resolves.toBe(false);
    await expect(
      submitExactUransCanaryStep({} as DB, legacyCanaryEngine, {
        requestId: "legacy-canary-request",
        meshRecoveryVersion: 1,
        uransRecoveryVersion: 2,
      }),
    ).resolves.toBe(false);
    expect(submissions).toBe(0);
  });

  it("holds direct ladder and canary entry points on a v3 reducer", async () => {
    let submissions = 0;
    const v3CanaryEngine = {
      healthDetails: async () => ({
        status: "ok",
        version: "archive-reducer-v3",
        archive_reduction_version: 3,
      }),
      submitPolar: async () => {
        submissions += 1;
        throw new Error("v3 reducer must not receive a physical request");
      },
    } as unknown as EngineClient;

    await expect(
      uransLadderTick({} as DB, v3CanaryEngine, 0, {
        archiveReductionVersion: 3,
      }),
    ).resolves.toBe(false);
    await expect(
      submitExactUransCanaryStep({} as DB, v3CanaryEngine, {
        requestId: "v3-canary-request",
        meshRecoveryVersion: 1,
        uransRecoveryVersion: 2,
      }),
    ).resolves.toBe(false);
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
    sharedCapacityAvailable: true,
    engineHealthy: true,
    meshRecoveryVersion: 4,
    archiveReductionVersion: 4,
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

  it("allows mirrored RANS after FAST priority has reserved its own slots", () => {
    expect(remoteAdmissionDecisionForTick(open)).toEqual({
      kind: "allow",
      meshRecoveryVersion: 4,
    });
  });

  it("keeps ordinary remote RANS behind FAST work beyond the bounded recovery pass", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        fastBacklogStillDue: true,
      }),
    ).toEqual({ kind: "hold", reason: "higher_priority_fast_urans" });
  });

  it("MUST-CATCH: a local FAST winner cannot suppress remote FAST discovery before RANS", () => {
    const loopSource = readFileSync(
      fileURLToPath(new URL("../src/loop.ts", import.meta.url)),
      "utf8",
    );
    const remoteFastStart = loopSource.indexOf(
      "const remoteFastCapacityRemaining =",
    );
    const remoteAdmissionStart = loopSource.indexOf(
      "let remoteAdmissionConsumed = false;",
      remoteFastStart,
    );
    const remoteFastBlock = loopSource.slice(
      remoteFastStart,
      remoteAdmissionStart,
    );

    expect(remoteFastStart).toBeGreaterThanOrEqual(0);
    expect(remoteAdmissionStart).toBeGreaterThan(remoteFastStart);
    expect(remoteFastBlock).toContain(
      "await submitRemotePromisePrecalcRecoveries(",
    );
    expect(remoteFastBlock).not.toMatch(
      /promotedSubmitted\s*\|\|\s*campaignTargetedSubmitted\s*\|\|\s*remoteFastSlotsAvailable/,
    );
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

  it("holds remote RANS when the current archive reducer is absent, stale, or malformed", () => {
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        archiveReductionVersion: 0,
      }),
    ).toEqual({
      kind: "hold",
      reason: "archive_reduction_capability_unavailable",
    });
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        archiveReductionVersion: 3,
      }),
    ).toEqual({
      kind: "hold",
      reason: "archive_reduction_capability_unavailable",
    });
    expect(
      remoteAdmissionDecisionForTick({
        ...open,
        archiveReductionVersion: null,
      }),
    ).toEqual({
      kind: "hold",
      reason: "archive_reduction_capability_unavailable",
    });
  });
});
