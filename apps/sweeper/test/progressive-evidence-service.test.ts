import type { DB, Sql } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  progressiveEvidenceDrain,
  runProgressiveEvidenceService,
} from "../src/progressive-evidence-service";
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

it("alternates current-work priority with oldest-first while both stages progress", async () => {
  const stage = vi.fn().mockResolvedValue(true);
  const deliver = vi.fn().mockResolvedValue(true);
  const drain = progressiveEvidenceDrain(stage, deliver);
  for (let pass = 0; pass < 4; pass += 1) expect(await drain()).toBe(true);
  expect(stage.mock.calls).toEqual([[true], [false], [true], [false]]);
  expect(deliver.mock.calls).toEqual(stage.mock.calls);
});

it("does not let permanent delivery errors prevent staging or vice versa", async () => {
  const stage = vi.fn().mockResolvedValue(true);
  const deliver = vi.fn().mockRejectedValue(new Error("old receipt conflict"));
  const drain = progressiveEvidenceDrain(stage, deliver);
  for (let pass = 0; pass < 3; pass += 1)
    await expect(drain()).rejects.toThrow(AggregateError);
  expect(stage).toHaveBeenCalledTimes(3);
  expect(stage.mock.calls).toEqual([[true], [false], [true]]);
  stage.mockRejectedValue(new Error("retained source staging error"));
  deliver.mockResolvedValue(true);
  await expect(drain()).rejects.toThrow(AggregateError);
  expect(deliver).toHaveBeenCalledTimes(4);
});

it("sleeps only when neither staging nor delivery made progress", async () => {
  const stage = vi.fn().mockResolvedValue(false);
  const deliver = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false);
  const drain = progressiveEvidenceDrain(stage, deliver);
  expect(await drain()).toBe(true);
  expect(await drain()).toBe(false);
});

it("starts delivery while staging is pending and waits for both before another pass", async () => {
  let finishStage: (progress: boolean) => void = () => {};
  let finishDelivery: (progress: boolean) => void = () => {};
  const stage = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishStage = resolve;
      }),
  );
  const deliver = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        finishDelivery = resolve;
      }),
  );
  const drain = progressiveEvidenceDrain(stage, deliver);
  let settled = false;
  const result = drain().then((value) => {
    settled = true;
    return value;
  });
  await Promise.resolve();
  expect(stage).toHaveBeenCalledWith(true);
  expect(deliver).toHaveBeenCalledWith(true);
  finishDelivery(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  finishStage(false);
  expect(await result).toBe(true);
  expect(stage).toHaveBeenCalledTimes(1);
  expect(deliver).toHaveBeenCalledTimes(1);
});

it("retains input-order errors and observes a pending sibling after an early failure", async () => {
  const first = new Error("stage failed");
  const second = new Error("delivery failed");
  let rejectStage: (error: Error) => void = () => {};
  let settled = false;
  const drain = progressiveEvidenceDrain(
    () =>
      new Promise<boolean>((_, reject) => {
        rejectStage = reject;
      }),
    () => {
      throw second;
    },
  );
  const result = drain().catch((error) => {
    settled = true;
    return error;
  });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  rejectStage(first);
  const error = await result;
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([first, second]);
});

it("picks up newly staged evidence on the next pass without inventing a receipt", async () => {
  let staged = false;
  const stage = async () => {
    await Promise.resolve();
    const changed = !staged;
    staged = true;
    return changed;
  };
  const delivered: boolean[] = [];
  const drain = progressiveEvidenceDrain(stage, async () => {
    delivered.push(staged);
    return staged;
  });
  expect(await drain()).toBe(true);
  expect(delivered).toEqual([false]);
  expect(await drain()).toBe(true);
  expect(delivered).toEqual([false, true]);
});

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
