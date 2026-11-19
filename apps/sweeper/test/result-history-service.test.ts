import type { DB } from "@aerodb/db/client";
import type { ResultHistoryArchiveStore } from "@aerodb/core/result-history-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  runResultHistoryOffloadPass,
  runResultHistoryStorageService,
} from "../src/result-history-service";

// The storage integration fixture covers byte custody and DB transitions.
// These isolated loop tests exercise cursor and wait policy without a database,
// cloud client, real timer or shared runtime.
// VITEST_PURE_REDUCER_TEST=1 omits the workspace's shared-DB setup for this file.
const mocked = vi.hoisted(() => ({
  candidates: vi.fn(),
  archive: vi.fn(),
  sleep: vi.fn(),
}));
vi.mock("@aerodb/db/result-history-storage", () => ({
  resultHistoryOffloadCandidates: mocked.candidates,
}));
vi.mock("../src/result-history-archive", () => ({
  archiveResultHistory: mocked.archive,
}));
vi.mock("../src/result-history-store", () => ({
  ResultHistoryStore: class {},
}));
vi.mock("node:timers/promises", () => ({ setTimeout: mocked.sleep }));

const id = (index: number) =>
  `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const db = {
  execute: async () => [{ id: "result-history-loop-fixture" }],
} as unknown as DB;
const store = {} as ResultHistoryArchiveStore;
type Candidate = {
  id: string;
  kind: "steady_history";
  byte_size: number;
  eligible: boolean;
};
function candidate(index: number, eligible = true): Candidate {
  return { id: id(index), kind: "steady_history", byte_size: 1024, eligible };
}
function pages(rows: Candidate[]) {
  mocked.candidates.mockImplementation(async (_db: DB, after: string | null) =>
    rows.filter((row) => after === null || row.id > after).slice(0, 32),
  );
}
function stopAfterSleeps(stop: AbortController, count: number) {
  mocked.sleep.mockImplementation(
    async (
      _ms: number,
      _value: undefined,
      options: { signal: AbortSignal },
    ) => {
      expect(options.signal).toBe(stop.signal);
      if (mocked.sleep.mock.calls.length === count) stop.abort();
    },
  );
}
beforeEach(() => {
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "history-fixture");
  vi.stubEnv("AIRFOILFOAM_DEPLOYMENT_ROLE", "hub");
  vi.stubEnv("AIRFOILFOAM_RESULT_HISTORY_OFFLOAD", "true");
  vi.stubEnv(
    "AIRFOILFOAM_HISTORY_SOURCE_INSTANCE",
    "result-history-loop-fixture",
  );
  mocked.candidates.mockResolvedValue([]);
  mocked.archive.mockResolvedValue({ offloaded: true, sourceBytes: 1024 });
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("result history forward scanning", () => {
  it.each(["skipped", "failed"] as const)(
    "keeps the cursor after a full %s page and reaches the following result",
    async (mode) => {
      pages([
        ...Array.from({ length: 32 }, (_, index) =>
          candidate(index + 1, mode === "failed"),
        ),
        candidate(33),
      ]);
      mocked.archive.mockImplementation(
        async (
          _db: DB,
          _store: ResultHistoryArchiveStore,
          input: { resultId: string },
        ) => {
          if (input.resultId !== id(33))
            throw new Error("one source failed verification");
          return { offloaded: true, sourceBytes: 1024 };
        },
      );
      const options = {
        bucket: "history-fixture",
        sourceInstance: "result-history-loop-fixture",
        maxRows: 32,
      };
      const first = await runResultHistoryOffloadPass(db, store, options);
      expect(first.next).toBe(id(32));
      expect(first.offloaded).toBe(0);
      expect(first.failures).toHaveLength(mode === "failed" ? 32 : 0);
      const second = await runResultHistoryOffloadPass(db, store, {
        ...options,
        after: first.next,
      });
      expect(second.offloaded).toBe(1);
      expect(second.next).toBe(id(33));
      const empty = await runResultHistoryOffloadPass(db, store, {
        ...options,
        after: second.next,
      });
      expect(empty.next).toBeNull();
      expect(mocked.candidates.mock.calls.map((call) => call[1])).toEqual([
        null,
        id(32),
        id(33),
      ]);
    },
  );
});

describe("result history service pacing", () => {
  it("yields briefly through skipped pages and successful uploads, then backs off at the empty tail", async () => {
    pages([
      ...Array.from({ length: 32 }, (_, index) => candidate(index + 1, false)),
      candidate(33),
    ]);
    const stop = new AbortController();
    stopAfterSleeps(stop, 3);
    await runResultHistoryStorageService(db, stop.signal);
    expect(mocked.sleep.mock.calls.map((call) => call[0])).toEqual([
      100, 100, 30_000,
    ]);
    expect(mocked.candidates.mock.calls.map((call) => call[1])).toEqual([
      null,
      id(32),
      id(33),
    ]);
    expect(mocked.archive).toHaveBeenCalledTimes(1);
  });

  it("advances past failed sources while retaining the error backoff", async () => {
    pages(Array.from({ length: 32 }, (_, index) => candidate(index + 1)));
    mocked.archive.mockRejectedValue(new Error("verification unavailable"));
    const stop = new AbortController();
    stopAfterSleeps(stop, 2);
    await runResultHistoryStorageService(db, stop.signal);
    expect(mocked.candidates.mock.calls.map((call) => call[1])).toEqual([
      null,
      id(8),
    ]);
    expect(mocked.sleep.mock.calls.map((call) => call[0])).toEqual([
      30_000, 30_000,
    ]);
    expect(mocked.archive).toHaveBeenCalledTimes(16);
  });

  it.each(["empty", "query error", "mixed upload failure"] as const)(
    "keeps the long backoff for %s",
    async (mode) => {
      if (mode === "query error")
        mocked.candidates.mockRejectedValue(new Error("database unavailable"));
      if (mode === "mixed upload failure") {
        pages([candidate(1), candidate(2)]);
        mocked.archive
          .mockResolvedValueOnce({ offloaded: true, sourceBytes: 1024 })
          .mockRejectedValueOnce(new Error("verification unavailable"));
      }
      const stop = new AbortController();
      stopAfterSleeps(stop, 1);
      await runResultHistoryStorageService(db, stop.signal);
      expect(mocked.sleep.mock.calls.map((call) => call[0])).toEqual([30_000]);
    },
  );
});
