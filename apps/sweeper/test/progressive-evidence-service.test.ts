import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProgressiveEvidenceService } from "../src/progressive-evidence-service";
import { runSweeperServices } from "../src/service-lifecycle";

function notifications() {
  let notify: () => void = () => undefined;
  const unlisten = vi.fn(async () => undefined);
  const listen = vi.fn(async (channel: string, callback: () => void) => {
    expect(channel).toBe("progressive_worker_evidence_changed");
    notify = callback;
    return { unlisten };
  });
  return {
    connection: { listen } as unknown as Pick<Sql, "listen">,
    notify: () => notify(),
    unlisten,
  };
}

afterEach(() => vi.useRealTimers());

describe("independent compact evidence delivery", () => {
  it("stages and delivers new evidence while the bulk transfer is blocked", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    let releaseArchive: () => void = () => undefined;
    const archive = new Promise<void>((resolve) => {
      releaseArchive = resolve;
    });
    let finished = false;
    const drain = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
    const running = runSweeperServices(owner.signal, [
      {
        name: "bulk-transfer",
        run: async () => {
          await archive;
          finished = true;
        },
      },
      {
        name: "compact-evidence",
        run: (signal) =>
          runProgressiveEvidenceService(
            {} as DB,
            channel.connection,
            {} as EngineClient,
            signal,
            { drain, nextWakeAt: async () => null },
          ),
      },
    ]);
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(2);
    expect(finished).toBe(false);
    channel.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(3);
    owner.abort();
    releaseArchive();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("sleeps until the exact durable retry deadline but immediately responds to new work", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const deadline = new Date(Date.now() + 2057);
    const drain = vi.fn().mockResolvedValue(false);
    const nextWakeAt = vi
      .fn()
      .mockResolvedValueOnce(deadline)
      .mockResolvedValueOnce(deadline)
      .mockResolvedValue(null);
    const running = runProgressiveEvidenceService(
      {} as DB,
      channel.connection,
      {} as EngineClient,
      owner.signal,
      { drain, nextWakeAt },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(drain).toHaveBeenCalledTimes(1);
    channel.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1056);
    expect(drain).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(10000);
    expect(drain).toHaveBeenCalledTimes(3);
    owner.abort();
    await running;
  });

  it("does not let self-notifications bypass failure backoff or delay cancellation", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const reportError = vi.fn();
    const drain = vi.fn(async () => {
      channel.notify();
      throw new Error("isolated staging failure");
    });
    const running = runProgressiveEvidenceService(
      {} as DB,
      channel.connection,
      {} as EngineClient,
      owner.signal,
      { drain, nextWakeAt: async () => null, reportError },
    );
    await vi.advanceTimersByTimeAsync(0);
    channel.notify();
    channel.notify();
    await vi.advanceTimersByTimeAsync(99);
    expect(drain).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
    expect(reportError).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("awaits its in-flight evidence operation before releasing the subscription", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = runProgressiveEvidenceService(
      {} as DB,
      channel.connection,
      {} as EngineClient,
      owner.signal,
      {
        drain: async () => {
          await pending;
          return false;
        },
        nextWakeAt: async () => null,
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    expect(channel.unlisten).not.toHaveBeenCalled();
    release();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });
});
