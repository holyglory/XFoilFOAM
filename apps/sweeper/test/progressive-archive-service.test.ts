import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { afterEach, expect, it, vi } from "vitest";
import { runProgressiveArchiveService } from "../src/progressive-archive-service";
import { nextProgressiveArchiveWakeAt } from "../src/progressive-worker-archive-delivery";
import { deliverNextProgressiveWorkerArchive } from "../src/remote-solver";

vi.mock("../src/remote-solver", () => ({
  deliverNextProgressiveWorkerArchive: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
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

it.each([
  [undefined, 8],
  ["1", 1],
  ["16", 16],
  ["32", 32],
] as const)(
  "uses the configured archive lane count %s",
  async (configured, expected) => {
    vi.useFakeTimers();
    vi.stubEnv("REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER", configured);
    const channel = notificationFixture();
    const owner = new AbortController();
    const drain = vi.fn().mockResolvedValue(false);
    const running = runProgressiveArchiveService(
      {} as DB,
      channel.connection,
      {} as EngineClient,
      owner.signal,
      { drain, nextWakeAt: async () => null },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(expected);
    owner.abort();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(expected);
  },
);

it.each(["", "0", "-1", "1.5", "33", "NaN", "Infinity", "unlimited"])(
  "rejects invalid archive concurrency %s before claiming work",
  async (configured) => {
    vi.stubEnv("REMOTE_EVIDENCE_MAX_ACTIVE_UPLOADS_PER_SOLVER", configured);
    const channel = notificationFixture();
    const drain = vi.fn();
    await expect(
      runProgressiveArchiveService(
        {} as DB,
        channel.connection,
        {} as EngineClient,
        new AbortController().signal,
        { drain },
      ),
    ).rejects.toThrow("integer from 1 through 32");
    expect(channel.connection.listen).not.toHaveBeenCalled();
    expect(drain).not.toHaveBeenCalled();
  },
);

function notificationFixture() {
  const listeners = new Set<() => void>();
  const unlisten = vi.fn(async () => {});
  const listen = vi.fn(async (channel: string, callback: () => void) => {
    expect(channel).toBe("progressive_worker_archive_changed");
    listeners.add(callback);
    return {
      unlisten: async () => {
        listeners.delete(callback);
        await unlisten();
      },
    };
  });
  return {
    connection: { listen } as unknown as Pick<Sql, "listen">,
    notify: () => {
      for (const listener of listeners) listener();
    },
    unlisten,
  };
}

it("retains the remote evidence configuration guard before an upload", async () => {
  vi.useFakeTimers();
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "not-a-remote-worker-bucket");
  const channel = notificationFixture();
  const owner = new AbortController();
  const reportError = vi.fn();
  const where = vi.fn().mockResolvedValue([
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
  expect(reportError).toHaveBeenCalledTimes(8);
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
  expect(drain).toHaveBeenCalledTimes(10);
  await vi.advanceTimersByTimeAsync(10000);
  expect(drain).toHaveBeenCalledTimes(10);
  channel.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(18);
  owner.abort();
  await running;
  expect(channel.unlisten).toHaveBeenCalledTimes(8);
});

it("waits for durable retry deadlines without spinning idle lanes", async () => {
  vi.useFakeTimers();
  const channel = notificationFixture();
  const owner = new AbortController();
  const retryAt = new Date(Date.now() + 2500);
  const drain = vi.fn().mockResolvedValue(false);
  const nextWakeAt = vi.fn(async () =>
    Date.now() < retryAt.getTime() ? retryAt : null,
  );
  const running = runProgressiveArchiveService(
    {} as DB,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { drain, nextWakeAt },
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(drain).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(2499);
  expect(drain).toHaveBeenCalledTimes(8);
  await vi.advanceTimersByTimeAsync(1);
  expect(drain).toHaveBeenCalledTimes(16);
  await vi.advanceTimersByTimeAsync(10000);
  expect(drain).toHaveBeenCalledTimes(16);
  owner.abort();
  await running;
});

it("refills actual delivery lanes while a sibling is slow and drains all owned transfers on shutdown", async () => {
  vi.useFakeTimers();
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_BUCKET", "");
  vi.stubEnv("AIRFOILFOAM_EVIDENCE_REMOTE_ONLY", "false");
  vi.stubEnv(
    "ENGINE_CONTROL_PLANE_TOKEN",
    "isolated-archive-test-token-32-characters",
  );
  const channel = notificationFixture();
  const owner = new AbortController();
  const where = vi.fn().mockResolvedValue([
    {
      upstreamBaseUrl: "https://hub.example/api/sync/v1",
      remoteSolverEnabled: true,
    },
  ]);
  const db = { select: () => ({ from: () => ({ where }) }) } as unknown as DB;
  const releases: Array<(result: boolean) => void> = [];
  let active = 0;
  let maximum = 0;
  vi.mocked(deliverNextProgressiveWorkerArchive).mockImplementation(
    async () => {
      active += 1;
      maximum = Math.max(active, maximum);
      return new Promise<boolean>((resolve) => {
        releases.push((result) => {
          active -= 1;
          resolve(result);
        });
      });
    },
  );
  let finished = false;
  const running = runProgressiveArchiveService(
    db,
    channel.connection,
    {} as EngineClient,
    owner.signal,
    { nextWakeAt: async () => null },
  ).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(active).toBe(8);
  expect(releases).toHaveLength(8);
  releases[0](true);
  await vi.advanceTimersByTimeAsync(0);
  expect(releases).toHaveLength(9);
  expect(active).toBe(8);
  channel.notify();
  channel.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(releases).toHaveLength(9);
  owner.abort();
  await vi.advanceTimersByTimeAsync(0);
  expect(finished).toBe(false);
  for (const release of releases.slice(1)) release(true);
  await running;
  expect(active).toBe(0);
  expect(maximum).toBe(8);
  expect(releases).toHaveLength(9);
  expect(channel.unlisten).toHaveBeenCalledTimes(8);
});
