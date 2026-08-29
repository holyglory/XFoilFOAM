import { describe, expect, it } from "vitest";

import { StaleWhileRefreshCache } from "../src/campaign-summary-metrics";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("campaign summary stale-while-refresh cache", () => {
  it("single-flights a cold load and serves fresh hits without another query", async () => {
    let now = 1_000;
    let calls = 0;
    const pending = deferred<number>();
    const cache = new StaleWhileRefreshCache<number>({
      ttlMs: 100,
      maxEntries: 4,
      now: () => now,
    });
    const loader = () => {
      calls += 1;
      return pending.promise;
    };

    const first = cache.get("campaign", loader);
    const second = cache.get("campaign", loader);
    expect(calls).toBe(1);
    pending.resolve(42);
    await expect(first).resolves.toMatchObject({ value: 42, stale: false });
    await expect(second).resolves.toMatchObject({ value: 42, stale: false });

    now += 50;
    await expect(cache.get("campaign", loader)).resolves.toMatchObject({
      value: 42,
      stale: false,
      refreshing: false,
    });
    expect(calls).toBe(1);
    expect(cache.stats()).toMatchObject({
      hits: 1,
      misses: 2,
      refreshes: 1,
      size: 1,
    });
  });

  it("returns a stale value immediately while exactly one refresh runs", async () => {
    let now = 0;
    let calls = 0;
    let next = deferred<number>();
    const cache = new StaleWhileRefreshCache<number>({
      ttlMs: 100,
      maxEntries: 4,
      now: () => now,
    });
    const loader = () => {
      calls += 1;
      return next.promise;
    };
    const cold = cache.get("campaign", loader);
    next.resolve(1);
    await cold;

    now = 101;
    next = deferred<number>();
    const stale = await cache.get("campaign", loader);
    const concurrent = await cache.get("campaign", loader);
    expect(stale).toMatchObject({ value: 1, stale: true, refreshing: true });
    expect(concurrent).toMatchObject({
      value: 1,
      stale: true,
      refreshing: true,
    });
    expect(calls).toBe(2);
    const refresh = cache.waitForRefresh("campaign");
    next.resolve(2);
    await refresh;
    await expect(cache.get("campaign", loader)).resolves.toMatchObject({
      value: 2,
      stale: false,
      refreshing: false,
    });
  });

  it("retains the last truthful value after refresh failure and retries later", async () => {
    let now = 0;
    let next = deferred<number>();
    const cache = new StaleWhileRefreshCache<number>({
      ttlMs: 10,
      maxEntries: 4,
      now: () => now,
    });
    const loader = () => next.promise;
    const cold = cache.get("campaign", loader);
    next.resolve(7);
    await cold;

    now = 11;
    next = deferred<number>();
    const stale = await cache.get("campaign", loader);
    expect(stale.value).toBe(7);
    const failedRefresh = cache.waitForRefresh("campaign");
    next.reject(new Error("refresh unavailable"));
    await expect(failedRefresh).rejects.toThrow("refresh unavailable");
    expect(cache.has("campaign")).toBe(true);

    next = deferred<number>();
    const retrying = await cache.get("campaign", loader);
    expect(retrying).toMatchObject({
      value: 7,
      stale: true,
      refreshing: true,
      lastError: "refresh unavailable",
    });
    const recoveredRefresh = cache.waitForRefresh("campaign");
    next.resolve(8);
    await recoveredRefresh;
    await expect(cache.get("campaign", loader)).resolves.toMatchObject({
      value: 8,
      stale: false,
      lastError: null,
    });
  });

  it("evicts the least-recently-used settled entry at the configured bound", async () => {
    let now = 0;
    const cache = new StaleWhileRefreshCache<number>({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    await cache.warm("a", async () => 1);
    now += 1;
    await cache.warm("b", async () => 2);
    now += 1;
    await cache.get("a", async () => 10);
    now += 1;
    await cache.warm("c", async () => 3);

    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
    expect(cache.has("c")).toBe(true);
    expect(cache.stats().size).toBe(2);
  });
});
