import { describe, expect, it, vi } from "vitest";

import {
  ARCHIVE_INTERPRETATION_MAX_ATTEMPTS,
  archiveInterpretationMayRetry,
  requireHistoricalReleasedArchiveAuditExecutionAuthority,
  runArchiveInterpretationBackfill,
} from "../src/result-interpretation-backfill";
import { HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT } from "../src/result-interpretations";

const RESULT_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const ARCHIVE_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_RESULT_ID = "44444444-4444-4444-8444-444444444444";

const EXACT_SOURCE = {
  resultId: RESULT_ID,
  resultAttemptId: ATTEMPT_ID,
  sourceArchiveId: ARCHIVE_ID,
};

function auditScope(exactSource = EXACT_SOURCE) {
  return {
    contract: HISTORICAL_RELEASED_ARCHIVE_AUDIT_CONTRACT,
    canonicalSelection: "forbidden",
    physicalRecovery: "record-only",
    campaignMutation: "forbidden",
    rawEvidenceImmutable: true,
    exactSource,
  };
}

/** Only implements the first read performed by `runArchiveInterpretationBackfill`.
 * Missing/mismatched audit authority must reject before any state refresh,
 * claim, or reducer I/O is attempted. */
function completedAuditRunDb(scope: Record<string, unknown>) {
  const limit = vi.fn().mockResolvedValue([
    {
      id: "55555555-5555-4555-8555-555555555555",
      reducerVersionId: "66666666-6666-4666-8666-666666666666",
      state: "completed",
      scope,
    },
  ]);
  const where = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

type FakeQuery = Record<string | symbol, unknown>;

const FAKE_QUERY_CHAIN_METHODS = new Set([
  "from",
  "innerJoin",
  "leftJoin",
  "where",
  "orderBy",
  "groupBy",
  "limit",
  "for",
]);

/**
 * Deliberately tiny Drizzle-shaped thenable for the one no-I/O branch below.
 * The responses are queued in call order, which makes the pointer-loss race
 * deterministic without a real database timing race between the admission
 * proof and the subsequent archive-pointer read.
 */
function fakeQuery(response: unknown): FakeQuery {
  const promise = Promise.resolve(response);
  let query: FakeQuery;
  query = new Proxy(promise as unknown as FakeQuery, {
    get(target, property, receiver) {
      if (property === "then") return promise.then.bind(promise);
      if (property === "catch") return promise.catch.bind(promise);
      if (property === "finally") return promise.finally.bind(promise);
      if (
        typeof property === "string" &&
        FAKE_QUERY_CHAIN_METHODS.has(property)
      ) {
        return () => query;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return query;
}

/**
 * The first historical source proof returns a valid candidate. The next
 * archive-pointer read then sees no archive row, modelling a local source
 * disappearance after admission without relying on scheduling timing. This
 * is exactly the branch that must settle `failed`, rather than manufacture a
 * scientific `missing_evidence` verdict.
 */
function historicalAuditPointerLossDb() {
  const runId = "55555555-5555-4555-8555-555555555555";
  const reducerVersionId = "66666666-6666-4666-8666-666666666666";
  const itemId = "77777777-7777-4777-8777-777777777777";
  const validBlob = {
    backend: "gcs",
    bucket: "airfoils-pro-storage-bucket",
    objectKey: `solver-evidence/v1/sha256/aa/${"a".repeat(64)}.tar.zst`,
    generation: "18446744073709551615",
    compression: "zstd",
    mimeType: "application/zstd",
    sha256: "a".repeat(64),
    byteSize: 12_345,
    crc32c: "AAAAAA==",
    uncompressedTarSha256: "b".repeat(64),
    uncompressedTarByteSize: 54_321,
    metadata: { archiveFormat: "tar+zstd", zstdLevel: 10 },
    verifiedAt: new Date("2026-07-30T00:00:00.000Z"),
  };
  const claimedItem = {
    id: itemId,
    runId,
    resultId: RESULT_ID,
    resultAttemptId: ATTEMPT_ID,
    sourceArchiveId: ARCHIVE_ID,
    attemptCount: 0,
  };
  const selectResponses: unknown[] = [
    [
      {
        id: runId,
        reducerVersionId,
        state: "running",
        scope: auditScope(),
      },
    ],
    [claimedItem],
    [
      {
        resultId: RESULT_ID,
        resultAttemptId: ATTEMPT_ID,
        evidencePayload: { fidelity: "urans_precalc" },
        status: "done",
        attemptSource: "solved",
        regime: "urans",
        unsteady: true,
        sourceArchiveId: ARCHIVE_ID,
        blob: validBlob,
      },
    ],
    [{ evidencePayload: { fidelity: "urans_precalc" } }],
    [],
    // `failHistoricalAuditClaimIfStillOwned` must still find the original
    // hydrating child after the local archive lookup loses its row.  Returning
    // an empty set here would model a reclaimed/deleted child and make this
    // test assert a failed settlement that can never occur.
    [{ id: itemId }],
    [{ state: "failed", count: 1 }],
    [{ events: 0, currentProjections: 0 }],
    [{ scope: auditScope() }],
    [{ count: 0 }],
  ];
  let selectIndex = 0;
  let settledItem: Record<string, unknown> = {
    state: "pending",
    claimToken: null,
    claimExpiresAt: null,
    resultInterpretationId: null,
    historicalAuditDecisionId: null,
    historicalAuditReducerState: null,
    historicalAuditInputEvidenceSignature: null,
    lastError: null,
  };
  let finalRun: Record<string, unknown> = { state: "running", summary: null };
  let db: Record<string, unknown>;

  const updateQuery = (): FakeQuery => {
    let values: Record<string, unknown> = {};
    let applied = false;
    const apply = () => {
      if (applied) return;
      applied = true;
      if ("summary" in values) {
        finalRun = { ...finalRun, ...values };
        return;
      }
      if (values.state === "running" && !("claimToken" in values)) {
        finalRun = { ...finalRun, ...values };
        return;
      }
      settledItem = { ...settledItem, ...values };
    };
    const promise = Promise.resolve([]);
    let query: FakeQuery;
    query = new Proxy(promise as unknown as FakeQuery, {
      get(target, property, receiver) {
        if (property === "set") {
          return (next: Record<string, unknown>) => {
            values = next;
            return query;
          };
        }
        if (property === "where") return () => query;
        if (property === "returning") {
          return () => {
            apply();
            return fakeQuery([{ id: itemId }]);
          };
        }
        if (property === "then") {
          return (...args: Parameters<Promise<unknown>["then"]>) => {
            apply();
            return promise.then(...args);
          };
        }
        if (property === "catch") return promise.catch.bind(promise);
        if (property === "finally") return promise.finally.bind(promise);
        return Reflect.get(target, property, receiver);
      },
    });
    return query;
  };

  db = {
    select: () => {
      const response = selectResponses[selectIndex++];
      if (response === undefined) {
        throw new Error("unexpected pointer-loss fake database select");
      }
      return fakeQuery(response);
    },
    update: () => updateQuery(),
    transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
      callback(db),
  };

  return {
    db,
    item: () => settledItem,
    run: () => finalRun,
    remainingSelects: () => selectResponses.length - selectIndex,
  };
}

/**
 * Models the narrow window after `readRun` proved an audit runnable but before
 * its activation update acquired the row. The owner-cascade writer wins that
 * race and turns the run into a forensic failure. A runner must neither start
 * reducer I/O nor issue a second summary update that could overwrite it.
 */
function terminalActivationRaceDb() {
  const runId = "55555555-5555-4555-8555-555555555555";
  const reducerVersionId = "66666666-6666-4666-8666-666666666666";
  const selectResponses: unknown[] = [
    [
      {
        id: runId,
        reducerVersionId,
        state: "planned",
        scope: auditScope(),
      },
    ],
    [],
    [{ events: 0, currentProjections: 0 }],
    [{ scope: auditScope(), state: "failed" }],
    [{ count: 0 }],
  ];
  let selectIndex = 0;
  const update = vi.fn(() => {
    const promise = Promise.resolve([]);
    let query: FakeQuery;
    query = new Proxy(promise as unknown as FakeQuery, {
      get(target, property, receiver) {
        if (property === "set" || property === "where") return () => query;
        if (property === "returning") return () => fakeQuery([]);
        if (property === "then") return promise.then.bind(promise);
        if (property === "catch") return promise.catch.bind(promise);
        if (property === "finally") return promise.finally.bind(promise);
        return Reflect.get(target, property, receiver);
      },
    });
    return query;
  });
  const db = {
    select: () => {
      const response = selectResponses[selectIndex++];
      if (response === undefined) {
        throw new Error("unexpected activation-race fake database select");
      }
      return fakeQuery(response);
    },
    update,
  };
  return {
    db,
    update,
    remainingSelects: () => selectResponses.length - selectIndex,
  };
}

describe("historical released-evidence audit execution authority", () => {
  it("requires the caller to repeat exactly the persisted three-ID source", () => {
    expect(
      requireHistoricalReleasedArchiveAuditExecutionAuthority({
        scope: auditScope(),
        exactSource: EXACT_SOURCE,
      }),
    ).toEqual(EXACT_SOURCE);

    expect(() =>
      requireHistoricalReleasedArchiveAuditExecutionAuthority({
        scope: auditScope(),
        exactSource: undefined,
      }),
    ).toThrow(/execution requires the exact resultId/);
    expect(() =>
      requireHistoricalReleasedArchiveAuditExecutionAuthority({
        scope: auditScope(),
        exactSource: { ...EXACT_SOURCE, resultId: OTHER_RESULT_ID },
      }),
    ).toThrow(/does not match the persisted audit source/);
  });

  it("MUST-CATCH: generic run resumption rejects before a completed audit can be read or retried", async () => {
    const db = completedAuditRunDb(auditScope());

    await expect(
      runArchiveInterpretationBackfill({
        db: db as never,
        engine: {} as never,
        runId: "55555555-5555-4555-8555-555555555555",
      }),
    ).rejects.toThrow(/execution requires the exact resultId/);

    expect(db.select).toHaveBeenCalledOnce();
  });

  it("MUST-CATCH: a mismatched authority also rejects before an audit receipt can resume", async () => {
    const db = completedAuditRunDb(auditScope());

    await expect(
      runArchiveInterpretationBackfill({
        db: db as never,
        engine: {} as never,
        runId: "55555555-5555-4555-8555-555555555555",
        historicalAuditExactSource: {
          ...EXACT_SOURCE,
          resultId: OTHER_RESULT_ID,
        },
      }),
    ).rejects.toThrow(/does not match the persisted audit source/);

    expect(db.select).toHaveBeenCalledOnce();
  });

  it("MUST-CATCH: an activation CAS miss preserves the terminal audit and does not run the reducer", async () => {
    const fake = terminalActivationRaceDb();
    const reduceRemoteEvidenceCleanCycles = vi.fn();

    const report = await runArchiveInterpretationBackfill({
      db: fake.db as never,
      engine: { reduceRemoteEvidenceCleanCycles } as never,
      runId: "55555555-5555-4555-8555-555555555555",
      maxItems: 1,
      historicalAuditExactSource: EXACT_SOURCE,
    });

    expect(report).toMatchObject({
      state: "failed",
      processed: 0,
      counts: {},
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
    });
    expect(reduceRemoteEvidenceCleanCycles).not.toHaveBeenCalled();
    // The only update is the activation CAS. A second update would be a stale
    // summary writer that can overwrite the terminal audit record.
    expect(fake.update).toHaveBeenCalledTimes(1);
    expect(fake.remainingSelects()).toBe(0);
  });

  it("keeps transient retries exclusive to queue-publication receipts", () => {
    expect(
      archiveInterpretationMayRetry({
        mode: "queue_publication",
        transient: true,
        attemptCount: 1,
      }),
    ).toBe(true);
    expect(
      archiveInterpretationMayRetry({
        mode: "historical_released_audit",
        transient: true,
        attemptCount: 1,
      }),
    ).toBe(false);
    expect(
      archiveInterpretationMayRetry({
        mode: "queue_publication",
        transient: true,
        attemptCount: ARCHIVE_INTERPRETATION_MAX_ATTEMPTS,
      }),
    ).toBe(false);
    expect(
      archiveInterpretationMayRetry({
        mode: "queue_publication",
        transient: false,
        attemptCount: 1,
      }),
    ).toBe(false);
  });

  it("MUST-CATCH: local pointer loss after historical admission is operationally failed, never a decisionless missing-evidence verdict", async () => {
    const fake = historicalAuditPointerLossDb();
    let reducerCalls = 0;

    const report = await runArchiveInterpretationBackfill({
      db: fake.db as never,
      engine: {
        reduceRemoteEvidenceCleanCycles: async () => {
          reducerCalls += 1;
          throw new Error("pointer-loss branch must not call the reducer");
        },
      } as never,
      runId: "55555555-5555-4555-8555-555555555555",
      maxItems: 1,
      historicalAuditExactSource: EXACT_SOURCE,
    });

    expect(reducerCalls).toBe(0);
    expect(fake.remainingSelects()).toBe(0);
    expect(report).toMatchObject({
      state: "failed",
      processed: 1,
      counts: { failed: 1 },
      canonicalSelectionsCreated: 0,
      resultProjectionsUpdated: 0,
    });
    expect(fake.item()).toMatchObject({
      state: "failed",
      claimToken: null,
      claimExpiresAt: null,
      resultInterpretationId: null,
      historicalAuditDecisionId: null,
      historicalAuditReducerState: null,
      historicalAuditInputEvidenceSignature: null,
      lastError: expect.stringContaining("immutable archive pointer is unavailable"),
    });
    expect(fake.run()).toMatchObject({ state: "failed" });
  });
});
