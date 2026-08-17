import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { WORKER_RESTART_ORPHAN_MESSAGE } from "@aerodb/engine-client";

import {
  ELIGIBLE_GATEWAY_AFFECTED_RUNTIMES,
  guardedReceiptCandidateDigest,
  LEGACY_GATEWAY_AFFECTED_RUNTIME,
  MAX_RECEIPT_ENGINE_MESSAGE_BYTES,
  MAX_RECEIPT_INPUT_BYTES,
  MAX_RECEIPT_JOB_IDS,
  parseGuardedEngineReceipt,
  parseMaintenanceReceiptReconcileArgs,
  readGuardedEngineReceipt,
  URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME,
  type GuardedEngineReceipt,
} from "../src/maintenance-receipt-reconcile-cli";

const JOB_A = "c24047fa-743f-4ae5-bcd6-f3071ff79fb4";
const JOB_B = "124e6078-a6cb-4a45-ab15-21eecbbcd34e";
const ENGINE_A = "b34c29e431584ab2a8f53df4381d8a5d";
const TOKEN = "69043e86-08f8-4609-81cc-35a9b5e3c1f1";

function guardedReceipt(
  candidateOverrides: Partial<GuardedEngineReceipt["candidates"][number]> = {},
): GuardedEngineReceipt {
  const candidate = {
    jobId: JOB_A,
    engineJobId: ENGINE_A,
    databaseStatus: "running" as const,
    engineStatus: "completed" as const,
    engineMessage: null,
    statusSha256: "a".repeat(64),
    resultSha256: "b".repeat(64),
    settlementAction: "ingest" as const,
    ...candidateOverrides,
  };
  return {
    schemaVersion: 1,
    maintenanceToken: TOKEN,
    affectedRuntime: LEGACY_GATEWAY_AFFECTED_RUNTIME,
    authoritativeObservedAt: "2026-08-02T12:00:00.000Z",
    candidates: [candidate] as GuardedEngineReceipt["candidates"],
    candidateDigest: guardedReceiptCandidateDigest([candidate]),
  };
}

describe("receipt-scoped maintenance reconciliation CLI", () => {
  it("pins the exact production gateway identity emitted by the guarded receipt producer", () => {
    expect(LEGACY_GATEWAY_AFFECTED_RUNTIME).toEqual({
      build_id: "b7d9213f59f2c1c19b8890b1500b81cf168d83aa",
      engine_version: "2606",
      urans_recovery_version: 12,
      archive_reduction_version: 4,
      queue_observation_version: 1,
    });
    expect(URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME).toEqual({
      build_id: "8d8aed9-clean-cycle-v13",
      engine_version: "2606",
      urans_recovery_version: 12,
      archive_reduction_version: 4,
      queue_observation_version: 1,
    });
    expect(ELIGIBLE_GATEWAY_AFFECTED_RUNTIMES).toEqual([
      LEGACY_GATEWAY_AFFECTED_RUNTIME,
      URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME,
    ]);
  });

  it("accepts only the complete canonical watcher receipt", () => {
    const receipt = guardedReceipt();
    expect(parseGuardedEngineReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });

  it("accepts the exact URANS clean-cycle gateway receipt", () => {
    const receipt = {
      ...guardedReceipt(),
      affectedRuntime: URANS_CLEAN_CYCLE_GATEWAY_AFFECTED_RUNTIME,
    } satisfies GuardedEngineReceipt;
    expect(parseGuardedEngineReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });

  it("uses a UTF-8 canonical candidate digest, including non-ASCII terminal messages", () => {
    const receipt = guardedReceipt({
      engineStatus: "failed",
      engineMessage: "météo — solver остановлен",
      settlementAction: "ingest",
    });
    expect(parseGuardedEngineReceipt(JSON.stringify(receipt))).toEqual(receipt);
  });

  it("accepts the producer's maximum 100-candidate, worst-case escaped 4 KiB-message receipt", async () => {
    const candidates: GuardedEngineReceipt["candidates"] = Array.from(
      { length: MAX_RECEIPT_JOB_IDS },
      (_, index) => {
        const suffix = index.toString(16).padStart(12, "0");
        return {
          jobId: `00000000-0000-4000-8000-${suffix}`,
          engineJobId: `00000000000040008001${suffix}`,
          databaseStatus: "running" as const,
          engineStatus: "failed" as const,
          engineMessage: "\u0000".repeat(MAX_RECEIPT_ENGINE_MESSAGE_BYTES),
          statusSha256: "a".repeat(64),
          resultSha256: "b".repeat(64),
          settlementAction: "ingest" as const,
        };
      },
    );
    const receipt: GuardedEngineReceipt = {
      schemaVersion: 1,
      maintenanceToken: TOKEN,
      affectedRuntime: LEGACY_GATEWAY_AFFECTED_RUNTIME,
      authoritativeObservedAt: "2026-08-02T12:00:00.000Z",
      candidates,
      candidateDigest: guardedReceiptCandidateDigest(candidates),
    };
    const raw = JSON.stringify(receipt);
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(MAX_RECEIPT_INPUT_BYTES);
    expect(parseGuardedEngineReceipt(raw)).toEqual(receipt);
    const directory = await mkdtemp(join(tmpdir(), "airfoils-receipt-"));
    try {
      const receiptFile = join(directory, "receipt.json");
      await writeFile(receiptFile, raw, "utf8");
      await expect(readGuardedEngineReceipt({ receiptFile })).resolves.toEqual(
        receipt,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the same UTF-8 byte budget as the Python receipt producer", () => {
    const accepted = guardedReceipt({
      engineStatus: "failed",
      engineMessage: "😀".repeat(MAX_RECEIPT_ENGINE_MESSAGE_BYTES / 4),
      settlementAction: "ingest",
    });
    expect(parseGuardedEngineReceipt(JSON.stringify(accepted))).toEqual(accepted);

    const rejected = guardedReceipt({
      engineStatus: "failed",
      engineMessage: `${"😀".repeat(MAX_RECEIPT_ENGINE_MESSAGE_BYTES / 4)}x`,
      settlementAction: "ingest",
    });
    expect(() => parseGuardedEngineReceipt(JSON.stringify(rejected))).toThrow(
      "engine message is invalid",
    );
  });

  it("rejects raw UUID arrays and incomplete or non-canonical receipts before any reconciliation", () => {
    expect(() => parseGuardedEngineReceipt(JSON.stringify([JOB_A]))).toThrow(
      "JSON object",
    );
    expect(() => parseGuardedEngineReceipt("not json")).toThrow("valid JSON");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({ schemaVersion: 1, candidates: [{ jobId: JOB_A }] }),
      ),
    ).toThrow("unexpected or missing fields");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({
          ...guardedReceipt(),
          maintenanceToken: TOKEN.toUpperCase(),
        }),
      ),
    ).toThrow("maintenance token is invalid");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({
          ...guardedReceipt(),
          candidates: Array.from({ length: MAX_RECEIPT_JOB_IDS + 1 }, () =>
            guardedReceipt().candidates[0],
          ),
        }),
      ),
    ).toThrow(`1 to ${MAX_RECEIPT_JOB_IDS}`);
  });

  it("keeps canonical database UUIDs distinct from exact engine job identifiers", () => {
    const hostileEngineIds = [
      ENGINE_A.toUpperCase(),
      "b34c29e4-3158-4ab2-a8f5-3df4381d8a5d",
      ENGINE_A.slice(0, -1),
      `${ENGINE_A}0`,
      ` ${ENGINE_A}`,
      `${ENGINE_A}\n`,
      `../${ENGINE_A}`,
      `${ENGINE_A.slice(0, -1)}g`,
      `${ENGINE_A}\u0000`,
    ];
    for (const engineJobId of hostileEngineIds) {
      expect(() =>
        parseGuardedEngineReceipt(
          JSON.stringify(guardedReceipt({ engineJobId })),
        ),
      ).toThrow("canonical lower-case 32-hex engine identity");
    }

    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify(guardedReceipt({ jobId: JOB_A.replaceAll("-", "") })),
      ),
    ).toThrow("canonical lower-case database UUID");
  });

  it("rejects receipt drift, digest tampering, and settlement actions that do not prove their terminal state", () => {
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({
          ...guardedReceipt(),
          affectedRuntime: { ...LEGACY_GATEWAY_AFFECTED_RUNTIME, engine_version: "2406" },
        }),
      ),
    ).toThrow("not the eligible legacy gateway");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({
          ...guardedReceipt(),
          affectedRuntime: {
            ...LEGACY_GATEWAY_AFFECTED_RUNTIME,
            queue_observation_version: true,
          },
        }),
      ),
    ).toThrow("not the eligible legacy gateway");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify({ ...guardedReceipt(), candidateDigest: "c".repeat(64) }),
      ),
    ).toThrow("candidate digest is invalid");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify(
          guardedReceipt({
            engineStatus: "cancelled",
            settlementAction: "ingest",
          }),
        ),
      ),
    ).toThrow("settlement does not match");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify(
          guardedReceipt({
            engineStatus: "failed",
            engineMessage: WORKER_RESTART_ORPHAN_MESSAGE,
            settlementAction: "ingest",
          }),
        ),
      ),
    ).toThrow("settlement does not match");
    expect(() =>
      parseGuardedEngineReceipt(
        JSON.stringify(
          guardedReceipt({
            engineStatus: "failed",
            engineMessage: "different message",
            settlementAction: "release_worker_restart_orphan",
          }),
        ),
      ),
    ).toThrow("settlement does not match");
  });

  it("accepts only --receipt-file and has no raw-list, stdin, or input-file transport", () => {
    expect(() => parseMaintenanceReceiptReconcileArgs([])).toThrow(
      "--receipt-file is required",
    );
    expect(
      parseMaintenanceReceiptReconcileArgs([
        "--",
        "--receipt-file",
        "/private/receipt.json",
      ]),
    ).toEqual({
      receiptFile: "/private/receipt.json",
      repairKnownRetryRollback: false,
    });
    expect(
      parseMaintenanceReceiptReconcileArgs([
        "--receipt-file",
        "/private/receipt.json",
        "--repair-known-retry-rollback",
      ]),
    ).toEqual({
      receiptFile: "/private/receipt.json",
      repairKnownRetryRollback: true,
    });
    expect(() =>
      parseMaintenanceReceiptReconcileArgs(["--input-file", "/private/jobs.json"]),
    ).toThrow("Unknown option");
  });
});
