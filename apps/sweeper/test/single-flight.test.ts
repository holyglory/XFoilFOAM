import { describe, expect, it, vi } from "vitest";

import { createSingleFlightBackgroundRunner } from "../src/single-flight";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("single-flight background runner", () => {
  it("MUST-CATCH: slow transfer work cannot overlap and releases its slot when complete", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const firstTask = vi.fn(() => first);
    const skippedTask = vi.fn(async () => undefined);
    const nextTask = vi.fn(async () => undefined);
    const onError = vi.fn();
    const run = createSingleFlightBackgroundRunner(onError);

    expect(run(firstTask)).toBe(true);
    expect(run(skippedTask)).toBe(false);
    await settle();
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(skippedTask).not.toHaveBeenCalled();

    finishFirst();
    await settle();
    expect(run(nextTask)).toBe(true);
    await settle();
    expect(nextTask).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it("reports a rejected task and permits the next pass", async () => {
    const onError = vi.fn();
    const run = createSingleFlightBackgroundRunner(onError);
    const failure = new Error("transfer failed");

    expect(run(async () => Promise.reject(failure))).toBe(true);
    await settle();
    expect(onError).toHaveBeenCalledWith(failure);
    expect(run(async () => undefined)).toBe(true);
  });
});
