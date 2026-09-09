import { describe, expect, it, vi } from "vitest";
import { runRemoteTransferSteps } from "../src/remote-transfer-steps";

describe("remote transfer step fairness", () => {
  it("runs archive delivery even when accepted delivery made progress", async () => {
    const accepted = vi.fn().mockResolvedValue(true);
    const archives = vi.fn().mockResolvedValue(true);
    expect(
      await runRemoteTransferSteps([
        { name: "accepted", run: accepted },
        { name: "archives", run: archives },
      ]),
    ).toEqual({ processed: true, errors: [] });
    expect(archives).toHaveBeenCalledOnce();
    expect(accepted.mock.invocationCallOrder[0]).toBeLessThan(
      archives.mock.invocationCallOrder[0],
    );
  });

  it("retains failures while continuing independent delivery steps", async () => {
    const calls: string[] = [];
    const receipt = await runRemoteTransferSteps([
      {
        name: "accepted",
        run: async () => {
          calls.push("accepted");
          throw new Error("transport unavailable");
        },
      },
      {
        name: "archives",
        run: async () => {
          calls.push("archives");
          return true;
        },
      },
      {
        name: "checkpoint",
        run: async () => {
          calls.push("checkpoint");
          return false;
        },
      },
    ]);
    expect(calls).toEqual(["accepted", "archives", "checkpoint"]);
    expect(receipt).toEqual({
      processed: true,
      errors: [{ step: "accepted", message: "transport unavailable" }],
    });
    expect(
      await runRemoteTransferSteps([{ name: "idle", run: async () => false }]),
    ).toEqual({ processed: false, errors: [] });
  });
});
