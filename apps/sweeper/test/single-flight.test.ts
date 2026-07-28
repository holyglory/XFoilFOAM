import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { runRetentionLoop } from "../src/retention";
import { createSingleFlightBackgroundRunner } from "../src/single-flight";

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const here = fileURLToPath(new URL(".", import.meta.url));

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

  it("MUST-CATCH: the independent retention loop drains one active pass on shutdown and never overlaps it", async () => {
    let finishPass!: () => void;
    let passStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      passStarted = resolve;
    });
    const activePass = new Promise<void>((resolve) => {
      finishPass = resolve;
    });
    const runPass = vi.fn(async () => {
      passStarted();
      await activePass;
    });
    const db = {} as DB;
    const engine = {} as EngineClient;
    const ac = new AbortController();
    let stopped = false;
    const loop = runRetentionLoop(db, engine, ac.signal, {
      pollIntervalMs: 0,
      runPass,
    }).then(() => {
      stopped = true;
    });

    await started;
    expect(runPass).toHaveBeenCalledTimes(1);
    ac.abort();
    await settle();
    expect(stopped).toBe(false);
    expect(runPass).toHaveBeenCalledTimes(1);

    finishPass();
    await loop;
    expect(stopped).toBe(true);
    expect(runPass).toHaveBeenCalledTimes(1);
  });
});

describe("retention process ownership", () => {
  it("MUST-CATCH: scheduler ticks never own retention and process shutdown joins both loops", () => {
    const loopSource = readFileSync(resolve(here, "../src/loop.ts"), "utf8");
    const bootstrapSource = readFileSync(
      resolve(here, "../src/index.ts"),
      "utf8",
    );

    expect(loopSource).not.toMatch(/retentionTick|scheduleRetentionTick/);
    expect(bootstrapSource).toContain("await runSweeperLifecycle({");
    expect(bootstrapSource).toContain("startScheduler:");
    expect(bootstrapSource).toContain("startRetention:");
    expect(bootstrapSource).toContain("closeResources:");
  });
});
