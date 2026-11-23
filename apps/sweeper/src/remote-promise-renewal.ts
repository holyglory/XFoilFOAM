import { runWithConcurrency } from "./reconcile";

// The control database pool has two connections. Even when work is waiting
// on registration or SQL, this worker leaves HTTP slots for starts and stops.
export function remotePromiseRenewalConcurrency(
  raw = process.env.SWEEPER_REMOTE_PROMISE_RENEWAL_CONCURRENCY,
): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 2) : 2;
}

const MAX_RETRY_MS = 60_000;

class PromiseRenewalRetries {
  private readonly entries = new Map<
    string,
    { retryAt: number; delay: number }
  >();

  deferredIds(): string[] {
    const now = Date.now();
    const ids: string[] = [];
    for (const [id, { retryAt }] of this.entries) {
      if (retryAt > now) ids.push(id);
      else if (now - retryAt >= MAX_RETRY_MS) this.entries.delete(id);
    }
    return ids;
  }

  defer(id: string, retryAfterMs = 0): void {
    const now = Date.now();
    const prior = this.entries.get(id);
    const delay = Math.min(
      MAX_RETRY_MS,
      Math.max(5_000, prior ? prior.delay * 2 : 0, retryAfterMs),
    );
    this.entries.set(id, { delay, retryAt: now + delay });
  }

  settled(id: string): void {
    this.entries.delete(id);
  }
}

// These deadlines throttle HTTP retries only. Restarting or changing the
// registered owner starts a new observation; only the hub can extend a lease.
const retryScopes = new WeakMap<
  object,
  { upstream: string; solver: string | null; retries: PromiseRenewalRetries }
>();
export function promiseRenewalRetries(
  db: object,
  upstream: string,
  solver: string | null,
): PromiseRenewalRetries {
  const current = retryScopes.get(db);
  if (current?.upstream === upstream && current.solver === solver)
    return current.retries;
  const retries = new PromiseRenewalRetries();
  retryScopes.set(db, { upstream, solver, retries });
  return retries;
}

export async function renewIndependentPromises<Item>(
  items: readonly Item[],
  concurrency: number,
  stopStarting: AbortSignal,
  renew: (item: Item) => Promise<void>,
): Promise<{ processed: number; deferred: number }> {
  if (!Number.isInteger(concurrency) || concurrency < 1)
    throw new Error(
      "Lease renewal requires a valid reconciliation concurrency",
    );
  const failures = new Map<number, unknown>();
  let processed = 0;
  let deferred = 0;
  await runWithConcurrency(items, concurrency, async (item, index) => {
    if (stopStarting.aborted) {
      deferred += 1;
      return;
    }
    try {
      processed += 1;
      await renew(item);
    } catch (error) {
      failures.set(index, error);
    }
  });
  if (failures.size) throw failures.get(Math.min(...failures.keys()));
  return { processed, deferred };
}
