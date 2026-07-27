export type ProbeCacheEntry<T> = {
  key: string;
  expiresAt: number;
  promise: Promise<T>;
  value: T | null;
  hasValue: boolean;
  inFlight: boolean;
};

export type ProbeCacheStore<T> = {
  current: ProbeCacheEntry<T> | null;
};

export interface ProbeCachePolicy<T> {
  /** TTL after a successful settled probe. */
  ttlMs: number;
  /** Maximum cold-request wait before returning the honest cap value. */
  capMs: number;
  /**
   * Optional longer retry interval for a settled failure. Engine HTTP aborts
   * do not cancel the already-running FastAPI handler, so rapidly retrying a
   * timed-out observability request can exhaust the gateway thread pool.
   */
  failureTtlMs?: number;
  isFailure?: (value: T) => boolean;
}

/**
 * TTL cache + stale-while-refresh with one strict live-probe owner.
 *
 * A pending probe remains the single-flight owner even after its nominal TTL
 * passes. This matters for abortable HTTP clients talking to synchronous
 * servers: starting a replacement request merely because the client-side TTL
 * expired can leave the abandoned server handler running and accumulate an
 * unbounded number of blocked threads.
 */
export function raceCachedProbe<T>(
  store: ProbeCacheStore<T>,
  key: string,
  policy: ProbeCachePolicy<T>,
  probe: () => Promise<T>,
  capValue: () => T,
): Promise<T> {
  const now = Date.now();
  const existing = store.current;
  if (existing?.inFlight && existing.key !== key) {
    // The requested identity changed (most often a different active-job set),
    // but the prior HTTP request is still live. Do not create a second server
    // handler. The old snapshot is not valid for the new identity, so return
    // the explicit unavailable/capped value until the owner settles.
    return Promise.resolve(capValue());
  }
  if (existing && existing.key === key) {
    if (existing.inFlight) {
      if (existing.hasValue) return Promise.resolve(existing.value as T);
      return Promise.race([
        existing.promise,
        new Promise<T>((resolve) =>
          setTimeout(() => resolve(capValue()), policy.capMs),
        ),
      ]);
    }
    if (existing.hasValue && existing.expiresAt > now) {
      return Promise.resolve(existing.value as T);
    }
  }

  const previous =
    existing?.key === key && existing.hasValue ? existing.value : null;
  const entry: ProbeCacheEntry<T> = {
    key,
    expiresAt: Number.POSITIVE_INFINITY,
    promise: Promise.resolve(capValue()),
    value: previous,
    hasValue: previous !== null,
    inFlight: true,
  };
  entry.promise = probe()
    .then((value) => {
      if (store.current === entry) {
        entry.value = value;
        entry.hasValue = true;
        const failed = policy.isFailure?.(value) ?? false;
        entry.expiresAt =
          Date.now() +
          (failed
            ? (policy.failureTtlMs ?? policy.ttlMs)
            : policy.ttlMs);
      }
      return value;
    })
    .finally(() => {
      if (store.current === entry) entry.inFlight = false;
    });
  store.current = entry;

  if (entry.hasValue) {
    void entry.promise.catch(() => undefined);
    return Promise.resolve(entry.value as T);
  }
  return Promise.race([
    entry.promise,
    new Promise<T>((resolve) =>
      setTimeout(() => resolve(capValue()), policy.capMs),
    ),
  ]);
}
