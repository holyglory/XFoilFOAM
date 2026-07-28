export type SweeperLoopStarter = (signal: AbortSignal) => Promise<void>;

export interface SweeperLifecycleOptions {
  controller: AbortController;
  startScheduler: SweeperLoopStarter;
  startRetention: SweeperLoopStarter;
  stopHeartbeat: () => void | Promise<void>;
  closeResources: () => void | Promise<void>;
}

type LoopName = "scheduler" | "retention";

type LoopExit =
  | { name: LoopName; status: "fulfilled" }
  | { name: LoopName; status: "rejected"; reason: unknown };

function observeLoop(
  name: LoopName,
  promise: Promise<void>,
): Promise<LoopExit> {
  return promise
    .then<LoopExit>(() => ({ name, status: "fulfilled" }))
    .catch<LoopExit>((reason: unknown) => ({
      name,
      status: "rejected",
      reason,
    }));
}

function addFailure(failures: unknown[], failure: unknown): void {
  if (!failures.some((existing) => Object.is(existing, failure))) {
    failures.push(failure);
  }
}

/**
 * Own the two long-running sweeper loops and their shared resources.
 *
 * Whichever loop exits first initiates shutdown of its peer. Both loops are
 * then allowed to drain before the heartbeat is stopped and PostgreSQL is
 * closed. This is especially important for retention: an abort prevents a new
 * destructive pass, but an active restart-safe pass must finish before its DB
 * connection disappears.
 */
export async function runSweeperLifecycle(
  options: SweeperLifecycleOptions,
): Promise<void> {
  const { controller } = options;
  // Defer both starters into microtasks so a synchronous throw from either
  // callback cannot prevent the other loop from taking ownership of its
  // shutdown path.
  const schedulerLoop = Promise.resolve().then(() =>
    options.startScheduler(controller.signal),
  );
  const retentionLoop = Promise.resolve().then(() =>
    options.startRetention(controller.signal),
  );
  const loops = [schedulerLoop, retentionLoop] as const;
  const firstExit = await Promise.race([
    observeLoop("scheduler", schedulerLoop),
    observeLoop("retention", retentionLoop),
  ]);
  const shutdownWasRequested = controller.signal.aborted;
  controller.abort();

  const settled = await Promise.allSettled(loops);
  const failures: unknown[] = [];
  if (firstExit.status === "rejected") {
    addFailure(failures, firstExit.reason);
  } else if (!shutdownWasRequested) {
    addFailure(
      failures,
      new Error(`${firstExit.name} loop exited before shutdown`),
    );
  }
  for (const result of settled) {
    if (result.status === "rejected") {
      addFailure(failures, result.reason);
    }
  }

  try {
    await options.stopHeartbeat();
  } catch (error) {
    addFailure(failures, error);
  }
  try {
    await options.closeResources();
  } catch (error) {
    addFailure(failures, error);
  }

  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Sweeper shutdown failed");
  }
}
