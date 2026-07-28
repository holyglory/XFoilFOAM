import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createLatestOnlyTaskController,
  createSerialPollController,
} from "../components/admin/campaigns/usePoll";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushPromises() {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("serial campaign polling", () => {
  it("MUST-CATCH: a request slower than the interval never overlaps another request", async () => {
    vi.useFakeTimers();
    const requests: ReturnType<typeof deferred>[] = [];
    let active = 0;
    let maxActive = 0;
    const controller = createSerialPollController(
      () => {
        const request = deferred();
        requests.push(request);
        active += 1;
        maxActive = Math.max(maxActive, active);
        return request.promise.finally(() => {
          active -= 1;
        });
      },
      10_000,
      () => false,
      120_000,
    );

    controller.start();
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(requests).toHaveLength(1);
    expect(maxActive).toBe(1);

    requests[0].resolve();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(9_999);
    expect(requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(requests).toHaveLength(2);
    expect(maxActive).toBe(1);

    controller.stop();
    requests[1].resolve();
    await flushPromises();
  });

  it("MUST-CATCH: a never-settling fetch is aborted at its budget and polling recovers", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const run = vi.fn(
      (signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    );
    const controller = createSerialPollController(
      run,
      10_000,
      () => false,
      1_000,
    );

    controller.start();
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();
    expect(signals[0].aborted).toBe(true);

    await vi.advanceTimersByTimeAsync(9_999);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
    controller.stop();
    expect(signals[1].aborted).toBe(true);
  });

  it("coalesces repeated visibility nudges into one immediate follow-up", async () => {
    vi.useFakeTimers();
    const requests: ReturnType<typeof deferred>[] = [];
    const controller = createSerialPollController(
      () => {
        const request = deferred();
        requests.push(request);
        return request.promise;
      },
      10_000,
      () => false,
    );

    controller.start();
    controller.nudge();
    controller.nudge();
    controller.nudge();
    expect(requests).toHaveLength(1);

    requests[0].resolve();
    await flushPromises();
    expect(requests).toHaveLength(2);

    controller.stop();
    requests[1].resolve();
    await flushPromises();
  });

  it("MUST-CATCH: downstream matrix generations coalesce without overlapping", async () => {
    const requests: ReturnType<typeof deferred>[] = [];
    let active = 0;
    let maxActive = 0;
    const controller = createLatestOnlyTaskController(() => {
      const request = deferred();
      requests.push(request);
      active += 1;
      maxActive = Math.max(maxActive, active);
      return request.promise.finally(() => {
        active -= 1;
      });
    });

    controller.request();
    controller.request();
    controller.request();
    controller.request();
    expect(requests).toHaveLength(1);

    requests[0].resolve();
    await flushPromises();
    expect(requests).toHaveLength(2);
    expect(maxActive).toBe(1);

    controller.stop();
    requests[1].resolve();
    await flushPromises();
    expect(requests).toHaveLength(2);
  });

  it("aborts an obsolete matrix refresh when its bounded controller stops", async () => {
    const signals: AbortSignal[] = [];
    const controller = createLatestOnlyTaskController(
      (signal) =>
        new Promise<void>((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
      10_000,
    );

    controller.request();
    expect(signals).toHaveLength(1);
    controller.stop();
    await flushPromises();
    expect(signals[0].aborted).toBe(true);
  });

  it("does not poll while hidden and resumes immediately when nudged", async () => {
    vi.useFakeTimers();
    let hidden = true;
    const run = vi.fn(async () => undefined);
    const controller = createSerialPollController(run, 10_000, () => hidden);

    controller.start();
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();

    hidden = false;
    controller.nudge();
    await flushPromises();
    expect(run).toHaveBeenCalledTimes(1);
    controller.stop();
  });
});
