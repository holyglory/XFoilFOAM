import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { PgDialect } from "drizzle-orm/pg-core";
import * as retention from "../src/retention";
import { runRetentionService } from "../src/retention-service";
import * as progressiveRetention from "../src/progressive-restart-retention";

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

it("serializes an emergency pass behind existing cleanup without dropping its options", async () => {
  vi.useFakeTimers();
  let release: (value: unknown[]) => void = () => {};
  const execute = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue([]);
  const db = { execute } as unknown as DB;
  const engine = {} as EngineClient;
  const first = retention.retentionTick(db, engine, { now: new Date(0) });
  const emergency = retention.retentionTick(db, engine, {
    now: new Date(0),
    reclaimOptionalCaseState: true,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(execute).toHaveBeenCalledOnce();
  release([]);
  await Promise.all([first, emergency]);
  expect(execute).toHaveBeenCalledTimes(2);
  const dialect = new PgDialect();
  const original = dialect.sqlToQuery(execute.mock.calls[0][0]);
  const requested = dialect.sqlToQuery(execute.mock.calls[1][0]);
  expect(original.sql).toBe(requested.sql);
  expect(requested.params).not.toEqual(original.params);
});

it("keeps cleanup active while scheduling is paused and preserves forecast reclamation", async () => {
  vi.useFakeTimers();
  const progressive = vi
    .spyOn(progressiveRetention, "reclaimProgressiveRestartState")
    .mockResolvedValue({ stripped: 1, bytesFreed: 0 });
  const cleanup = vi.spyOn(retention, "retentionTick").mockResolvedValue();
  const db = {
    execute: vi
      .fn()
      .mockResolvedValue([{ enabled: false, disk_admission_blocked: true }]),
  } as unknown as DB;
  const engine = {} as EngineClient;
  const owner = new AbortController();
  const running = runRetentionService(db, engine, owner.signal);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(cleanup).toHaveBeenCalledWith(db, engine, {
      reclaimOptionalCaseState: true,
    });
    expect(progressive).toHaveBeenCalledWith(db, engine);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cleanup).toHaveBeenCalledTimes(2);
  } finally {
    owner.abort();
    await running;
  }
  await vi.advanceTimersByTimeAsync(20000);
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it("does not overlap slow cleanup and drains it when the service stops", async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const cleanup = vi.spyOn(retention, "retentionTick").mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const db = {
    execute: vi.fn().mockResolvedValue([{ disk_admission_blocked: false }]),
  } as unknown as DB;
  const owner = new AbortController();
  let finished = false;
  const running = runRetentionService(
    db,
    {} as EngineClient,
    owner.signal,
  ).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(15000);
  expect(cleanup).toHaveBeenCalledOnce();
  owner.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  release();
  await running;
  expect(finished).toBe(true);
  await vi.advanceTimersByTimeAsync(20000);
  expect(cleanup).toHaveBeenCalledOnce();
});

it("uses the existing cleanup batch and stops when pressure reclamation is exhausted", async () => {
  vi.useFakeTimers();
  vi.spyOn(retention, "retentionTick").mockResolvedValue();
  vi.spyOn(retention, "retentionConfigFromEnv").mockReturnValue({
    ...retention.retentionConfigFromEnv(),
    stripMaxPerTick: 2,
  });
  const reclaim = vi
    .spyOn(progressiveRetention, "reclaimProgressiveRestartState")
    .mockResolvedValueOnce({ stripped: 1, bytesFreed: 8192 })
    .mockResolvedValue({ stripped: 0, bytesFreed: 0 });
  const db = {
    execute: vi.fn().mockResolvedValue([{ disk_admission_blocked: true }]),
  } as unknown as DB;
  const owner = new AbortController();
  const running = runRetentionService(db, {} as EngineClient, owner.signal);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(reclaim).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5000);
    expect(reclaim).toHaveBeenCalledTimes(3);
  } finally {
    owner.abort();
    await running;
  }
});
