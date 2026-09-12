import { afterEach, expect, it, vi } from "vitest";
import type { DB, Sql } from "@aerodb/db";
import { acknowledgeProgressiveRemoteStops } from "../src/progressive-remote-stop-receipt";
import { reconcileProgressiveRemoteProgress } from "../src/progressive-remote-progress";
import { runProgressiveHubProgressService } from "../src/progressive-hub-progress-service";
import { prepareProgressiveRemoteFleet } from "../src/progressive-remote-admission";
vi.mock("../src/progressive-remote-admission", () => ({
  prepareProgressiveRemoteFleet: vi.fn(),
}));

vi.mock("../src/progressive-remote-stop-receipt", () => ({
  acknowledgeProgressiveRemoteStops: vi.fn(),
}));
vi.mock("../src/progressive-remote-progress", () => ({
  reconcileProgressiveRemoteProgress: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.mocked(prepareProgressiveRemoteFleet).mockResolvedValue({
    prepared: 0,
    deferred: 0,
    waiting: 1,
    errors: [],
  });
  let notify = () => {};
  const unlisten = vi.fn(async () => {});
  const notifications = {
    listen: vi.fn(async (_name: string, callback: () => void) => {
      notify = callback;
      return { unlisten };
    }),
  } as unknown as Pick<Sql, "listen">;
  vi.mocked(acknowledgeProgressiveRemoteStops).mockResolvedValue({
    acknowledged: 0,
    errors: [],
  });
  vi.mocked(reconcileProgressiveRemoteProgress).mockResolvedValue({
    applied: 0,
    indexed: 0,
    stopped: 0,
    settled: 0,
    waiting: 1,
    errors: [],
  });
  return { notifications, unlisten, notify: () => notify() };
}

it("releases exact stop receipts before replay and drains available ordered reports without controller ticks", async () => {
  const scope = fixture();
  const order: string[] = [];
  vi.mocked(prepareProgressiveRemoteFleet).mockImplementation(async () => {
    order.push("admission");
    return { prepared: 0, deferred: 0, waiting: 1, errors: [] };
  });
  vi.mocked(acknowledgeProgressiveRemoteStops).mockImplementation(async () => {
    order.push("stop");
    return { acknowledged: 0, errors: [] };
  });
  vi.mocked(reconcileProgressiveRemoteProgress)
    .mockImplementationOnce(async () => {
      order.push("progress");
      return {
        applied: 1,
        indexed: 0,
        stopped: 0,
        settled: 0,
        waiting: 0,
        errors: [],
      };
    })
    .mockImplementation(async () => {
      order.push("progress");
      return {
        applied: 0,
        indexed: 0,
        stopped: 0,
        settled: 0,
        waiting: 1,
        errors: [],
      };
    });
  const owner = new AbortController();
  const running = runProgressiveHubProgressService(
    {} as DB,
    scope.notifications,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toEqual([
    "stop",
    "progress",
    "admission",
    "stop",
    "progress",
    "admission",
  ]);
  await vi.advanceTimersByTimeAsync(4999);
  expect(order).toHaveLength(6);
  scope.notify();
  await vi.advanceTimersByTimeAsync(0);
  expect(order).toHaveLength(9);
  owner.abort();
  await running;
  expect(scope.unlisten).toHaveBeenCalledOnce();
});

it("retains notifications and drains an in-flight acknowledgement on shutdown", async () => {
  const scope = fixture();
  let release!: () => void;
  vi.mocked(acknowledgeProgressiveRemoteStops).mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ acknowledged: 0, errors: [] });
      }),
  );
  const owner = new AbortController();
  let finished = false;
  const running = runProgressiveHubProgressService(
    {} as DB,
    scope.notifications,
    owner.signal,
  ).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  scope.notify();
  scope.notify();
  owner.abort();
  expect(finished).toBe(false);
  expect(acknowledgeProgressiveRemoteStops).toHaveBeenCalledOnce();
  release();
  await running;
  expect(scope.unlisten).toHaveBeenCalledOnce();
  expect(finished).toBe(true);
  expect(prepareProgressiveRemoteFleet).not.toHaveBeenCalled();
});

it("keeps filling available assignments without waiting for another controller tick", async () => {
  const scope = fixture();
  vi.mocked(prepareProgressiveRemoteFleet).mockResolvedValueOnce({
    prepared: 2,
    deferred: 0,
    waiting: 1,
    errors: [],
  });
  const owner = new AbortController();
  const running = runProgressiveHubProgressService(
    {} as DB,
    scope.notifications,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(prepareProgressiveRemoteFleet).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(prepareProgressiveRemoteFleet).toHaveBeenCalledTimes(3);
  owner.abort();
  await running;
});

it("continues after deferring an owned target, then sleeps when no further progress is ready", async () => {
  const scope = fixture();
  vi.mocked(prepareProgressiveRemoteFleet).mockResolvedValueOnce({
    prepared: 0,
    deferred: 2,
    waiting: 0,
    errors: [],
  });
  const owner = new AbortController();
  const running = runProgressiveHubProgressService(
    {} as DB,
    scope.notifications,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(prepareProgressiveRemoteFleet).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(4000);
  expect(prepareProgressiveRemoteFleet).toHaveBeenCalledTimes(2);
  owner.abort();
  await running;
  expect(scope.unlisten).toHaveBeenCalledOnce();
});
