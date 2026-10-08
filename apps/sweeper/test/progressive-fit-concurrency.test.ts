import { expect, it } from "vitest";
import {
  runProgressiveFitBatches,
  type ProgressiveFitBatchSummary,
} from "../src/progressive-fit-concurrency";

const summary = (
  claimed: number,
  stored: number,
  errors: string[] = [],
): ProgressiveFitBatchSummary => ({ claimed, stored, errors });

it("runs bounded fit batches concurrently and aggregates their receipts", async () => {
  let active = 0;
  let maximumActive = 0;

  const result = await runProgressiveFitBatches(3, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return summary(1, 1);
  });

  expect(maximumActive).toBe(3);
  expect(result).toEqual(summary(3, 3));
});

it("keeps fit concurrency bounded", async () => {
  let active = 0;
  let maximumActive = 0;

  await runProgressiveFitBatches(99, async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active -= 1;
    return summary(1, 0, ["fixture"]);
  });

  expect(maximumActive).toBe(16);
});
