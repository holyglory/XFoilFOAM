import { runWithConcurrency } from "./reconcile";

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
