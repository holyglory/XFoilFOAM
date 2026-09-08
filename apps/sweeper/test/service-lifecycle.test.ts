import { describe, expect, it, vi } from "vitest";
import { runSweeperServices } from "../src/service-lifecycle";

function untilStopped(signal: AbortSignal, stopped: () => void) {
  return new Promise<void>((resolve) => {
    const finish = () => {
      stopped();
      resolve();
    };
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}

describe("required sweeper service lifecycle", () => {
  it("starts both services and observes both shutdowns before returning", async () => {
    const owner = new AbortController();
    const stopped = vi.fn();
    const starts: string[] = [];
    const running = runSweeperServices(
      owner.signal,
      ["controller", "polars"].map((name) => ({
        name,
        run: async (signal: AbortSignal) => {
          starts.push(name);
          await untilStopped(signal, () => stopped(name));
        },
      })),
    );
    expect(starts).toEqual(["controller", "polars"]);
    owner.abort();
    await running;
    expect(stopped.mock.calls).toEqual([["controller"], ["polars"]]);
  });

  it("aborts and awaits the other service when one fails during startup", async () => {
    const owner = new AbortController();
    const failure = new Error("database subscription failed");
    const stopped = vi.fn();
    await expect(
      runSweeperServices(owner.signal, [
        {
          name: "polars",
          run: async () => {
            throw failure;
          },
        },
        { name: "controller", run: (signal) => untilStopped(signal, stopped) },
      ]),
    ).rejects.toBe(failure);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(owner.signal.aborted).toBe(false);
  });

  it("does not leave a partial service running after an unexpected successful exit", async () => {
    const owner = new AbortController();
    const stopped = vi.fn();
    await expect(
      runSweeperServices(owner.signal, [
        { name: "polars", run: async () => undefined },
        { name: "controller", run: (signal) => untilStopped(signal, stopped) },
      ]),
    ).rejects.toThrow("stopped before shutdown: polars");
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it("does not start work after an already-requested shutdown", async () => {
    const owner = new AbortController();
    owner.abort();
    const run = vi.fn();
    await runSweeperServices(owner.signal, [{ name: "controller", run }]);
    expect(run).not.toHaveBeenCalled();
  });
});
