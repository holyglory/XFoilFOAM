import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import { runProgressiveArchiveService } from "../src/progressive-archive-service";
import { nextProgressiveArchiveWakeAt } from "../src/progressive-worker-archive-delivery";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it("preserves fractional-millisecond input dates at JavaScript clock precision", async () => {
  const date = new Date("2026-09-09T12:00:00.723Z");
  for (const value of [date, "2026-09-09 12:00:00.723891+00"]) {
    const db = {
      execute: vi.fn().mockResolvedValue([{ wake_at: value }]),
    } as unknown as DB;
    expect(await nextProgressiveArchiveWakeAt(db)).toEqual(date);
  }
});

function notificationFixture() {
  let publish = () => {};
  const unlisten = vi.fn(async () => {});
  const listen = vi.fn(async (channel: string, callback: () => void) => {
    expect(channel).toBe("progressive_worker_archive_changed");
    publish = callback;
    return { unlisten };
  });
  return {
    connection: { listen } as unknown as Pick<Sql, "listen">,
    notify: () => publish(),
    unlisten,
  };
}

it("retains the remote evidence configuration guard before an upload", async () => {
  vi.useFakeTimers();
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "not-a-remote-worker-bucket");
  const channel = notificationFixture();
  const owner = new AbortController();
  const reportError = vi.fn();
  const where = vi
    .fn()
    .mockResolvedValue([
      {
        upstreamBaseUrl: "https://hub.example/api/sync/v1",
        remoteSolverEnabled: true,
      },
    ]);
  const db = { select: () => ({ from: () => ({ where }) }) } as unknown as DB;
  const running = runProgressiveArchiveService(
    db,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { reportError },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(reportError).toHaveBeenCalledOnce();
  expect(String(reportError.mock.calls[0][0])).toContain(
    "configuration is unsafe",
  );
  owner.abort();
  await running;
});

it("drains retained archives immediately without waiting for another controller tick", async () => {
  vi.useFakeTimers();
  const channel = notificationFixture();
  const owner = new AbortController();
  const drain = vi
    .fn()
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  const running = runProgressiveArchiveService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { drain, nextWakeAt: async () => null },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(10000);
  expect(drain).toHaveBeenCalledTimes(3);
  channel.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(4);
  owner.abort();
  await running;
  expect(channel.unlisten).toHaveBeenCalledOnce();
});

it("waits for durable retry deadlines and keeps one upload in flight", async () => {
  vi.useFakeTimers();
  const channel = notificationFixture();
  const owner = new AbortController();
  const retryAt = new Date(Date.now() + 2500);
  let release: () => void = () => {};
  const upload = new Promise<void>((resolve) => {
    release = resolve;
  });
  const drain = vi
    .fn()
    .mockImplementationOnce(async () => {
      await upload;
      return true;
    })
    .mockResolvedValue(false);
  const nextWakeAt = vi
    .fn()
    .mockResolvedValueOnce(retryAt)
    .mockResolvedValue(null);
  const running = runProgressiveArchiveService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { drain, nextWakeAt },
  );
  await vi.advanceTimersByTimeAsync(0);
  channel.notify();
  channel.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(1);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2499);
  expect(drain).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(drain).toHaveBeenCalledTimes(3);
  owner.abort();
  await running;
});
