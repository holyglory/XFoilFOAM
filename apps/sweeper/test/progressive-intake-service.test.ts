import { afterEach, expect, it, vi } from "vitest";
import type { DB } from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";
import { receiveProgressiveAssignmentPage } from "../src/progressive-remote-intake";
import { receiveProgressiveCampaignAssignments } from "../src/remote-solver";
import { runProgressiveAssignmentIntakeService } from "../src/progressive-intake-service";

vi.mock("../src/remote-solver", () => ({
  receiveProgressiveCampaignAssignments: vi.fn(),
}));
vi.mock("node:timers/promises", () => ({
  setTimeout: (
    milliseconds: number,
    value: unknown,
    options: { signal: AbortSignal },
  ) =>
    new Promise((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", finish);
        if (options.signal.aborted) reject(new Error("aborted"));
        else resolve(value);
      };
      const timer = setTimeout(finish, milliseconds);
      options.signal.addEventListener("abort", finish, { once: true });
      if (options.signal.aborted) finish();
    }),
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
});

it("shares a slow intake between the independent service and controller", async () => {
  let release!: (rows: unknown[]) => void;
  const execute = vi.fn().mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const db = { execute } as unknown as DB;
  const receive = vi.fn();
  const first = receiveProgressiveAssignmentPage(db, receive);
  const second = receiveProgressiveAssignmentPage(db, receive);
  expect(execute).toHaveBeenCalledOnce();
  release([]);
  expect(await first).toEqual(await second);
  expect(receive).not.toHaveBeenCalled();
  execute.mockResolvedValue([]);
  await receiveProgressiveAssignmentPage(db, receive);
  expect(execute).toHaveBeenCalledTimes(2);
});

it.each([
  { remote_solver_enabled: false },
  { remote_solver_enabled: true, remote_solver_transfer_paused: true },
])(
  "does not fetch or mirror while intake is disabled or under maintenance",
  async (settings) => {
    const receive = vi.fn();
    const fetcher = vi.fn();
    const db = {
      execute: vi.fn().mockResolvedValue([settings]),
    } as unknown as DB;
    const result = await receiveProgressiveAssignmentPage(db, receive, fetcher);
    expect(result.seen).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
  },
);

it("continues receiving pages without waiting for controller work and drains shutdown", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const intake = vi.mocked(receiveProgressiveCampaignAssignments);
  const receipt = {
    seen: 0,
    mirrored: 0,
    existing: 0,
    stopped: 0,
    cursorAdvanced: false,
    errors: [],
  };
  intake.mockResolvedValueOnce(receipt).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = () => resolve(receipt);
      }),
  );
  const owner = new AbortController();
  let finished = false;
  const running = runProgressiveAssignmentIntakeService(
    {} as DB,
    {} as EngineClient,
    owner.signal,
  ).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(intake).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(intake).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(15000);
  expect(intake).toHaveBeenCalledTimes(2);
  owner.abort();
  expect(finished).toBe(false);
  release();
  await running;
  expect(finished).toBe(true);
});

it("retries a failed page and clears failed single-flight ownership", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => {});
  const owner = new AbortController();
  const intake = vi.mocked(receiveProgressiveCampaignAssignments);
  intake
    .mockRejectedValueOnce(new Error("bounded request timeout"))
    .mockImplementationOnce(async () => {
      owner.abort();
      return {
        seen: 0,
        mirrored: 0,
        existing: 0,
        stopped: 0,
        cursorAdvanced: false,
        errors: [],
      };
    });
  const running = runProgressiveAssignmentIntakeService(
    {} as DB,
    {} as EngineClient,
    owner.signal,
  );
  await vi.advanceTimersByTimeAsync(5000);
  await running;
  expect(intake).toHaveBeenCalledTimes(2);
  const execute = vi
    .fn()
    .mockRejectedValueOnce(new Error("database unavailable"))
    .mockResolvedValue([]);
  const db = { execute } as unknown as DB;
  await expect(receiveProgressiveAssignmentPage(db, vi.fn())).rejects.toThrow(
    "database unavailable",
  );
  await expect(
    receiveProgressiveAssignmentPage(db, vi.fn()),
  ).resolves.toMatchObject({ seen: 0 });
});
