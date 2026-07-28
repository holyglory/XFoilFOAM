import { describe, expect, it, vi } from "vitest";

import { runSweeperLifecycle } from "../src/lifecycle";

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("sweeper process lifecycle", () => {
  it("MUST-CATCH: scheduler failure aborts and drains retention before resources close", async () => {
    const controller = new AbortController();
    const retentionStarted = deferred();
    const retentionDrained = deferred();
    const finishRetention = deferred();
    const schedulerFailure = new Error("scheduler failed");
    const events: string[] = [];

    const stopHeartbeat = vi.fn(() => {
      events.push("heartbeat:stopped");
    });
    const closeResources = vi.fn(async () => {
      events.push("resources:closed");
    });

    const lifecycle = runSweeperLifecycle({
      controller,
      startScheduler: async () => {
        events.push("scheduler:started");
        await retentionStarted.promise;
        events.push("scheduler:failed");
        throw schedulerFailure;
      },
      startRetention: async (signal) => {
        events.push("retention:started");
        retentionStarted.resolve();
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener("abort", () => resolve(), { once: true });
        });
        events.push("retention:aborted");
        await finishRetention.promise;
        events.push("retention:drained");
        retentionDrained.resolve();
      },
      stopHeartbeat,
      closeResources,
    });
    const result = lifecycle.then(
      () => null,
      (error: unknown) => error,
    );

    await retentionStarted.promise;
    await new Promise<void>((resolve) => {
      if (controller.signal.aborted) resolve();
      else
        controller.signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
    });

    expect(controller.signal.aborted).toBe(true);
    expect(events).toContain("retention:aborted");
    expect(events).not.toContain("retention:drained");
    expect(stopHeartbeat).not.toHaveBeenCalled();
    expect(closeResources).not.toHaveBeenCalled();

    finishRetention.resolve();
    await retentionDrained.promise;
    expect(closeResources).not.toHaveBeenCalled();

    expect(await result).toBe(schedulerFailure);
    expect(events).toEqual([
      "scheduler:started",
      "retention:started",
      "scheduler:failed",
      "retention:aborted",
      "retention:drained",
      "heartbeat:stopped",
      "resources:closed",
    ]);
    expect(stopHeartbeat).toHaveBeenCalledTimes(1);
    expect(closeResources).toHaveBeenCalledTimes(1);
  });

  it("closes resources after both loops settle during requested shutdown", async () => {
    const controller = new AbortController();
    const loopsStarted = deferred();
    let started = 0;
    const events: string[] = [];
    const waitForAbort = async (name: string, signal: AbortSignal) => {
      events.push(`${name}:started`);
      started += 1;
      if (started === 2) loopsStarted.resolve();
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      events.push(`${name}:settled`);
    };

    const lifecycle = runSweeperLifecycle({
      controller,
      startScheduler: (signal) => waitForAbort("scheduler", signal),
      startRetention: (signal) => waitForAbort("retention", signal),
      stopHeartbeat: () => {
        events.push("heartbeat:stopped");
      },
      closeResources: () => {
        events.push("resources:closed");
      },
    });

    await loopsStarted.promise;
    controller.abort();
    await lifecycle;

    const closeIndex = events.indexOf("resources:closed");
    expect(closeIndex).toBeGreaterThan(events.indexOf("scheduler:settled"));
    expect(closeIndex).toBeGreaterThan(events.indexOf("retention:settled"));
    expect(events.at(-2)).toBe("heartbeat:stopped");
    expect(events.at(-1)).toBe("resources:closed");
  });
});
