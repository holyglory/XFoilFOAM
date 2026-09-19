import { describe, expect, it, vi } from "vitest";
import {
  cleanupOwnedFixtureIds,
  fixtureCleanupLifecycle,
} from "../test-support/fixture-ownership";

describe("fixture cleanup ownership", () => {
  it("retains ownership after a failed removal and permits an honest retry", async () => {
    const identifiers = ["first", "second"];
    const cleanup = vi.fn().mockRejectedValueOnce(new Error("removal refused"));
    await expect(cleanupOwnedFixtureIds(identifiers, cleanup)).rejects.toThrow(
      "removal refused",
    );
    expect(identifiers).toEqual(["first", "second"]);
    cleanup.mockResolvedValueOnce(undefined);
    await cleanupOwnedFixtureIds(identifiers, cleanup);
    expect(cleanup.mock.calls).toEqual([
      [["first", "second"]],
      [["first", "second"]],
    ]);
    expect(identifiers).toEqual([]);
  });

  it("removes only the cleaned snapshot and preserves later identifiers", async () => {
    const identifiers = ["first", "first"];
    await cleanupOwnedFixtureIds(identifiers, async (owned) => {
      expect(owned).toEqual(["first"]);
      identifiers.push("later");
      owned.push("later");
    });
    expect(identifiers).toEqual(["later"]);
  });

  it("still performs namespace cleanup when the explicit ID list is empty", async () => {
    const cleanup = vi.fn().mockResolvedValue(undefined);
    await cleanupOwnedFixtureIds([], cleanup);
    expect(cleanup).toHaveBeenCalledWith([]);
  });

  it("requires successful recovery before the next normal scenario", async () => {
    const cleanup = vi
      .fn()
      .mockRejectedValue(new Error("fixture remains dirty"));
    const lifecycle = fixtureCleanupLifecycle(cleanup);
    await lifecycle.beforeEach();
    expect(cleanup).not.toHaveBeenCalled();
    await expect(lifecycle.afterEach()).rejects.toThrow(
      "fixture remains dirty",
    );
    await expect(lifecycle.beforeEach()).rejects.toThrow(
      "fixture remains dirty",
    );
    cleanup.mockResolvedValue(undefined);
    await lifecycle.beforeEach();
    await lifecycle.afterEach();
    expect(cleanup).toHaveBeenCalledTimes(4);
    await lifecycle.beforeEach();
    expect(cleanup).toHaveBeenCalledTimes(4);
  });

  it("joins a still-running cleanup rather than deleting concurrently", async () => {
    let release!: () => void;
    const cleanup = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const lifecycle = fixtureCleanupLifecycle(cleanup);
    await lifecycle.beforeEach();
    const finishing = lifecycle.afterEach();
    const recovering = lifecycle.beforeEach();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([finishing, recovering]);
    const finalCleanup = lifecycle.afterEach();
    await Promise.resolve();
    expect(cleanup).toHaveBeenCalledTimes(2);
    release();
    await finalCleanup;
  });
});
