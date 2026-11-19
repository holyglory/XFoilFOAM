import type { DB } from "@aerodb/db/client";
import { MAX_SOLVER_HISTORY_BYTES } from "@aerodb/core/solver-history-storage";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { runForceHistoryOffloadPass, runSolverHistoryStorageService } from "../src/solver-history-service";
import type { SolverHistoryArchiveStore } from "../src/solver-history-archive";

// The real PostgreSQL/object transition is covered in solver-history-storage.
// These isolated scheduling cases must model 32 oversized rows without
// allocating a gigabyte of fixture histories in a shared test database.
const mock = vi.hoisted(() => ({ candidates: vi.fn(), archive: vi.fn(), sleep: vi.fn() }));
vi.mock("@aerodb/db/solver-history-storage", () => ({ forceHistoryOffloadCandidates: mock.candidates }));
vi.mock("../src/solver-history-archive", () => ({ archiveSolverHistory: mock.archive }));
vi.mock("../src/solver-history-store", () => ({ SolverHistoryStore: class {} }));
vi.mock("node:timers/promises", () => ({ setTimeout: mock.sleep }));
beforeEach((): void => {
  mock.candidates.mockReset(); mock.archive.mockReset(); mock.sleep.mockReset();
  mock.archive.mockResolvedValue({ offloaded: true, sourceBytes: 10 });
});
afterEach((): void => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const db = {} as DB, store = {} as SolverHistoryArchiveStore;
const options = { bucket: "history-fixture", sourceInstance: "history-fixture" };
const id = (n: number) => `f0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

it("advances past a full oversized first page to later eligible work, then wraps only at an empty tail", async () => {
  const rows = [
    ...Array.from({ length: 32 }, (_, i) => ({ id: id(i + 1), byte_size: MAX_SOLVER_HISTORY_BYTES + 1 })),
    { id: id(33), byte_size: 10 },
  ];
  mock.candidates.mockImplementation(async (_db, after: string | null) => rows.filter((r) => !after || r.id > after).slice(0, 32));
  const skipped = await runForceHistoryOffloadPass(db, store, options);
  expect(skipped).toMatchObject({ processed: 0, offloaded: 0, next: id(32), failures: [] });
  expect(mock.archive).not.toHaveBeenCalled();
  const productive = await runForceHistoryOffloadPass(db, store, { ...options, after: skipped.next });
  expect(productive).toMatchObject({ processed: 1, offloaded: 1, next: id(33) });
  expect(mock.archive).toHaveBeenCalledTimes(1);
  expect(mock.archive.mock.calls[0][2].sourceId).toBe(id(33));
  const tail = await runForceHistoryOffloadPass(db, store, { ...options, after: productive.next });
  expect(tail.next).toBeNull();
  expect(mock.candidates.mock.calls.map((call) => call[1])).toEqual([null, id(32), id(33)]);
});

it.each([false, true])("preserves a full page cursor when failures=%s", async (failed) => {
  const rows = Array.from({ length: 32 }, (_, i) => ({ id: id(i + 1), byte_size: 10 }));
  mock.candidates.mockResolvedValue(rows);
  if (failed) mock.archive.mockRejectedValue(new Error("persistent archive failure"));
  const pass = await runForceHistoryOffloadPass(db, store, { ...options, maxRows: 32 });
  expect(pass.next).toBe(id(32));
  expect(pass.processed).toBe(32);
  expect(pass.offloaded).toBe(failed ? 0 : 32);
  expect(pass.failures).toHaveLength(failed ? 32 : 0);
});

it("retains the last visited cursor when a bounded pass stops before the remaining candidates", async () => {
  mock.candidates.mockResolvedValue(Array.from({ length: 32 }, (_, i) => ({ id: id(i + 1), byte_size: 10 })));
  const pass = await runForceHistoryOffloadPass(db, store, { ...options, maxRows: 2 });
  expect(pass.next).toBe(id(2));
  expect(mock.archive).toHaveBeenCalledTimes(2);
});

it("yields briefly for productive backlog and retains idle/error backoff through the real service loop", async () => {
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", options.bucket);
  vi.stubEnv("AIRFOILFOAM_FORCE_HISTORY_OFFLOAD", "true");
  vi.stubEnv("AIRFOILFOAM_HISTORY_SOURCE_INSTANCE", options.sourceInstance);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  mock.candidates.mockResolvedValueOnce([{ id: id(1), byte_size: 10 }]).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("query unavailable"));
  const controller = new AbortController(), delays: number[] = [];
  mock.sleep.mockImplementation(async (delay: number, _value, setup) => {
    expect(setup.signal).toBe(controller.signal);
    delays.push(delay);
    if (delays.length === 3) controller.abort();
  });
  const localDb = { execute: vi.fn(async () => [{ id: options.sourceInstance }]) } as unknown as DB;
  await runSolverHistoryStorageService(localDb, controller.signal);
  expect(delays).toHaveLength(3);
  expect(delays[0]).toBeGreaterThan(0);
  expect(delays[0]).toBeLessThanOrEqual(1000);
  expect(delays[1]).toBeGreaterThanOrEqual(30_000);
  expect(delays[2]).toBe(delays[1]);
});

it("backs off a partially failed pass even when another item was offloaded", async () => {
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", options.bucket);
  vi.stubEnv("AIRFOILFOAM_FORCE_HISTORY_OFFLOAD", "true");
  vi.stubEnv("AIRFOILFOAM_HISTORY_SOURCE_INSTANCE", options.sourceInstance);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  mock.candidates.mockResolvedValue([{ id: id(1), byte_size: 10 }, { id: id(2), byte_size: 10 }]);
  mock.archive.mockRejectedValueOnce(new Error("one failed archive"));
  const controller = new AbortController();
  mock.sleep.mockImplementation(async (delay: number) => {
    expect(delay).toBeGreaterThanOrEqual(30_000); controller.abort();
  });
  const localDb = { execute: vi.fn(async () => [{ id: options.sourceInstance }]) } as unknown as DB;
  await runSolverHistoryStorageService(localDb, controller.signal);
  expect(mock.archive).toHaveBeenCalledTimes(2); expect(mock.sleep).toHaveBeenCalledTimes(1);
});
