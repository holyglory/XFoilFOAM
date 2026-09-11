import { afterEach, expect, it, vi } from "vitest";
import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { runArchiveReclaimService } from "../src/archive-reclaim-service";

afterEach(() => vi.useRealTimers());

function fixture(drain: () => Promise<number>) {
  const owner = new AbortController();
  let notify = () => {};
  const unlisten = vi.fn(async () => {});
  const listen = vi.fn(async (channel: string, callback: () => void) => {
    expect(channel).toBe("progressive_worker_archive_changed");
    notify = callback;
    return { unlisten };
  });
  const reportError = vi.fn();
  const running = runArchiveReclaimService(
    {} as DB,
    { listen } as unknown as Pick<Sql, "listen">,
    {} as EngineClient,
    owner.signal,
    { drain, nextWakeAt: async () => null, reportError },
  );
  return { owner, running, reportError, unlisten, notify: () => notify() };
}

it("continues useful batches immediately and backs off when no work is ready", async () => {
  vi.useFakeTimers();
  const drain = vi
    .fn()
    .mockResolvedValueOnce(4)
    .mockResolvedValueOnce(3)
    .mockResolvedValue(0);
  const scope = fixture(drain);
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(999);
  expect(drain).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(drain).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1999);
  expect(drain).toHaveBeenCalledTimes(4);
  scope.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(5);
  scope.owner.abort();
  await scope.running;
  expect(scope.unlisten).toHaveBeenCalledOnce();
});

it("never overlaps a slow pass and waits for its completion on shutdown", async () => {
  vi.useFakeTimers();
  let release: (count: number) => void = () => {};
  const drain = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const scope = fixture(drain);
  await vi.advanceTimersByTimeAsync(0);
  scope.notify();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(drain).toHaveBeenCalledOnce();
  let finished = false;
  const joined = scope.running.then(() => {
    finished = true;
  });
  scope.owner.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  release(4);
  await joined;
  expect(drain).toHaveBeenCalledOnce();
});

it("backs off failures instead of adding a hot retry loop", async () => {
  vi.useFakeTimers();
  const drain = vi.fn().mockRejectedValue(new Error("storage unavailable"));
  const scope = fixture(drain);
  await vi.advanceTimersByTimeAsync(999);
  expect(drain).toHaveBeenCalledOnce();
  expect(scope.reportError).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(drain).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(drain).toHaveBeenCalledTimes(2);
  scope.owner.abort();
  await scope.running;
});
