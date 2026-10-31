import { describe, expect, it } from "vitest";
import { progressiveGenerationStages } from "../src/progressive-campaigns";
import { fastV2BenchmarkPriority } from "../src/progressive-fast-v2-benchmark";

describe("fast-v2 benchmark stage barrier", () => {
  it("creates only baseline and fast stages for benchmark generations", () => {
    expect(progressiveGenerationStages(true)).toEqual([1, 2]);
    expect(progressiveGenerationStages(false)).toEqual([1, 2, 3]);
  });

  it("places the benchmark below the source campaign priority", () => {
    expect(fastV2BenchmarkPriority(9)).toBe(8);
    expect(fastV2BenchmarkPriority(1)).toBe(0);
    expect(fastV2BenchmarkPriority(0)).toBe(0);
  });
});
