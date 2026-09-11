import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { renewIndependentPromises } from "../src/remote-promise-renewal";

it("renews independent promises concurrently within the existing caller capacity", async () => {
  const controller = new AbortController();
  let active = 0;
  let maximum = 0;
  const seen: number[] = [];
  const summary = await renewIndependentPromises(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    controller.signal,
    async (item) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await nextTurn();
      seen.push(item);
      active -= 1;
    },
  );
  expect(maximum).toBe(4);
  expect(summary).toEqual({ processed: 20, deferred: 0 });
  expect(active).toBe(0);
  expect(seen.sort((left, right) => left - right)).toEqual(
    Array.from({ length: 20 }, (_, index) => index),
  );
});

it("observes all safe siblings and preserves the first input-order failure", async () => {
  const first = new Error("first promise failed");
  const second = new Error("second promise failed");
  let rejectFirst: (error: Error) => void = () => {};
  let rejectSecond: (error: Error) => void = () => {};
  const started: number[] = [];
  const finished: number[] = [];
  let settled = false;
  const running = renewIndependentPromises(
    [0, 1, 2],
    2,
    new AbortController().signal,
    async (item) => {
      started.push(item);
      try {
        if (item === 0)
          await new Promise<void>((_, reject) => {
            rejectFirst = reject;
          });
        if (item === 1)
          await new Promise<void>((_, reject) => {
            rejectSecond = reject;
          });
      } finally {
        finished.push(item);
      }
    },
  ).catch((error) => {
    settled = true;
    return error;
  });
  await nextTurn();
  expect(started).toEqual([0, 1]);
  rejectSecond(second);
  await nextTurn();
  expect(started).toEqual([0, 1, 2]);
  expect(settled).toBe(false);
  rejectFirst(first);
  expect(await running).toBe(first);
  expect(finished.sort()).toEqual([0, 1, 2]);
});

it("aborts genuinely stalled HTTP responses and never starts queued renewals after expiry", async () => {
  let received = 0;
  let ready: () => void = () => {};
  const bothReceived = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const server = createServer(() => {
    received += 1;
    if (received === 2) ready();
  });
  const controller = new AbortController();
  const requestController = new AbortController();
  let attempted = 0;
  try {
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const port = (server.address() as AddressInfo).port;
    const running = renewIndependentPromises(
      [0, 1, 2, 3, 4],
      2,
      controller.signal,
      async () => {
        attempted += 1;
        await fetch(`http://127.0.0.1:${port}/heartbeat`, {
          signal: requestController.signal,
        });
      },
    ).catch((error) => error);
    await bothReceived;
    controller.abort(new Error("launch budget"));
    await nextTurn();
    requestController.abort(new Error("request timeout"));
    expect(await running).toMatchObject({ message: "request timeout" });
    expect(attempted).toBe(2);
    expect(received).toBe(2);
  } finally {
    controller.abort();
    requestController.abort();
    server.closeAllConnections();
    if (server.listening)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("waits for owned work and defers remaining items without treating a launch budget as an outage", async () => {
  let finish: () => void = () => {};
  let settled = false;
  const controller = new AbortController();
  const operation = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const running = renewIndependentPromises(
    [0, 1],
    1,
    controller.signal,
    operation,
  ).then(
    (value) => {
      settled = true;
      return value;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await nextTurn();
  controller.abort(new Error("deadline"));
  await nextTurn();
  expect(settled).toBe(false);
  finish();
  expect(await running).toEqual({ processed: 1, deferred: 1 });
  expect(settled).toBe(true);
  expect(operation).toHaveBeenCalledTimes(1);
});

it.each([0, -1, 1.5, NaN, Infinity])(
  "refuses invalid capacity %s without pretending to renew",
  async (concurrency) => {
    const operation = vi.fn();
    await expect(
      renewIndependentPromises(
        [0],
        concurrency,
        new AbortController().signal,
        operation,
      ),
    ).rejects.toThrow("valid reconciliation concurrency");
    expect(operation).not.toHaveBeenCalled();
  },
);

it("does not call the transport for an empty batch", async () => {
  const operation = vi.fn();
  const result = await renewIndependentPromises(
    [],
    4,
    new AbortController().signal,
    operation,
  );
  expect(result).toEqual({ processed: 0, deferred: 0 });
  expect(operation).not.toHaveBeenCalled();
});

it("reports an expired launch budget as untouched deferred work", async () => {
  const operation = vi.fn();
  const controller = new AbortController();
  controller.abort();
  expect(
    await renewIndependentPromises([0, 1], 4, controller.signal, operation),
  ).toEqual({ processed: 0, deferred: 2 });
  expect(operation).not.toHaveBeenCalled();
});
