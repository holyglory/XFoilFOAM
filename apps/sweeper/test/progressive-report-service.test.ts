import type { DB, Sql } from "@aerodb/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runProgressiveReportService } from "../src/progressive-report-service";
import { runSweeperServices } from "../src/service-lifecycle";

function notifications() {
  let notify: () => void = () => undefined;
  const unlisten = vi.fn(async () => undefined);
  return {
    connection: {
      listen: vi.fn(async (_channel: string, callback: () => void) => {
        notify = callback;
        return { unlisten };
      }),
    } as unknown as Pick<Sql, "listen">,
    notify: () => notify(),
    unlisten,
  };
}

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(() => vi.useRealTimers());

describe("independent progressive report delivery", () => {
  it("publishes queued observations while an archive transfer remains blocked", async () => {
    const channel = notifications();
    const owner = new AbortController();
    const archive = deferred();
    const published = deferred();
    let archiveFinished = false;
    const publish = vi.fn(async () => {
      published.resolve();
      return false;
    });
    const running = runSweeperServices(owner.signal, [
      {
        name: "archive-transfer",
        run: async () => {
          await archive.promise;
          archiveFinished = true;
        },
      },
      {
        name: "reports",
        run: (signal) =>
          runProgressiveReportService({} as DB, channel.connection, signal, {
            publish,
          }),
      },
    ]);
    await published.promise;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(archiveFinished).toBe(false);
    owner.abort();
    archive.resolve();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("drains pending reports serially, sleeps when idle and resumes on notification", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const publish = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10000);
    expect(publish).toHaveBeenCalledTimes(2);
    channel.notify();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(3);
    owner.abort();
    await running;
  });

  it("retains wakeups during a slow publication and awaits it during shutdown", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const pending = deferred();
    const publish = vi
      .fn()
      .mockImplementationOnce(async () => {
        await pending.promise;
        return false;
      })
      .mockResolvedValue(false);
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    );
    await vi.advanceTimersByTimeAsync(0);
    channel.notify();
    channel.notify();
    expect(publish).toHaveBeenCalledTimes(1);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
  });

  it("does not close the subscription or exit while its final publication is in flight", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const pending = deferred();
    const publish = vi.fn(async () => {
      await pending.promise;
      return false;
    });
    let finished = false;
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish },
    ).then(() => {
      finished = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    owner.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(channel.unlisten).not.toHaveBeenCalled();
    pending.resolve();
    await running;
    expect(finished).toBe(true);
    expect(channel.unlisten).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it("retries a failed publication without a new report and cancels retry on shutdown", async () => {
    vi.useFakeTimers();
    const channel = notifications();
    const owner = new AbortController();
    const failure = new Error("isolated unavailable hub");
    const publish = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(false);
    const reportError = vi.fn();
    const running = runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
      { publish, reportError },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(reportError).toHaveBeenCalledWith(failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(publish).toHaveBeenCalledTimes(2);
    owner.abort();
    await running;
    await vi.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("does not subscribe after shutdown and propagates subscription failure", async () => {
    const channel = notifications();
    const owner = new AbortController();
    owner.abort();
    await runProgressiveReportService(
      {} as DB,
      channel.connection,
      owner.signal,
    );
    expect(channel.connection.listen).not.toHaveBeenCalled();
    const failure = new Error("isolated subscription failure");
    vi.mocked(channel.connection.listen).mockRejectedValueOnce(failure);
    await expect(
      runProgressiveReportService(
        {} as DB,
        channel.connection,
        new AbortController().signal,
      ),
    ).rejects.toBe(failure);
  });
});
