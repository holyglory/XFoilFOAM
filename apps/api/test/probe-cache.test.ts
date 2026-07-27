import { afterEach, describe, expect, it, vi } from "vitest";

import {
  raceCachedProbe,
  type ProbeCacheStore,
} from "../src/probe-cache";

type Snapshot = { value: string | null; error: string | null };

function store(): ProbeCacheStore<Snapshot> {
  return { current: null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("raceCachedProbe", () => {
  it("keeps one live owner after the nominal TTL while the probe is unresolved", async () => {
    vi.useFakeTimers();
    let resolveProbe: ((value: Snapshot) => void) | null = null;
    const probe = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const cache = store();
    const policy = { ttlMs: 50, capMs: 10 };
    const cap = () => ({ value: null, error: "still running" });

    const first = raceCachedProbe(cache, "engine", policy, probe, cap);
    await vi.advanceTimersByTimeAsync(11);
    await expect(first).resolves.toEqual({
      value: null,
      error: "still running",
    });

    // The cache's nominal TTL has passed, but the first live request still
    // owns the single-flight. A replacement would abandon another synchronous
    // server handler and recreate the production thread-pool exhaustion.
    await vi.advanceTimersByTimeAsync(100);
    const second = raceCachedProbe(cache, "engine", policy, probe, cap);
    await vi.advanceTimersByTimeAsync(11);
    await expect(second).resolves.toEqual({
      value: null,
      error: "still running",
    });
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe?.({ value: "healthy", error: null });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(cache.current?.inFlight).toBe(false);
  });

  it("does not overlap a pending probe when the requested cache key changes", async () => {
    let resolveProbe: ((value: Snapshot) => void) | null = null;
    const probe = vi.fn(
      () =>
        new Promise<Snapshot>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const cache = store();
    const policy = { ttlMs: 50, capMs: 10 };
    const cap = () => ({ value: null, error: "still running" });

    void raceCachedProbe(cache, "jobs:a", policy, probe, cap);
    await expect(
      raceCachedProbe(cache, "jobs:b", policy, probe, cap),
    ).resolves.toEqual({ value: null, error: "still running" });
    expect(probe).toHaveBeenCalledTimes(1);

    resolveProbe?.({ value: "jobs:a", error: null });
    await Promise.resolve();
    await Promise.resolve();
    await expect(
      raceCachedProbe(cache, "jobs:b", policy, probe, cap),
    ).resolves.toEqual({ value: null, error: "still running" });
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it("backs off settled failures from their completion time", async () => {
    vi.useFakeTimers();
    const probe = vi
      .fn<() => Promise<Snapshot>>()
      .mockResolvedValueOnce({ value: null, error: "timed out" })
      .mockResolvedValueOnce({ value: "healthy", error: null });
    const cache = store();
    const policy = {
      ttlMs: 50,
      capMs: 10,
      failureTtlMs: 1_000,
      isFailure: (value: Snapshot) => value.error != null,
    };
    const cap = () => ({ value: null, error: "still running" });

    await expect(
      raceCachedProbe(cache, "engine", policy, probe, cap),
    ).resolves.toEqual({ value: null, error: "timed out" });
    await vi.advanceTimersByTimeAsync(200);
    await expect(
      raceCachedProbe(cache, "engine", policy, probe, cap),
    ).resolves.toEqual({ value: null, error: "timed out" });
    expect(probe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(801);
    // The stale failure is returned immediately while one replacement probe
    // begins in the background.
    await expect(
      raceCachedProbe(cache, "engine", policy, probe, cap),
    ).resolves.toEqual({ value: null, error: "timed out" });
    expect(probe).toHaveBeenCalledTimes(2);
    await vi.runAllTicks();
    expect(cache.current?.value).toEqual({ value: "healthy", error: null });
  });
});
