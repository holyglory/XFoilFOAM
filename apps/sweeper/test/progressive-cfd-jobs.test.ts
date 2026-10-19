import { describe, expect, it } from "vitest";

import {
  progressiveFastSolverProcesses,
  progressiveSolverProcessesForStage,
} from "../src/progressive-cfd-jobs";

describe("progressive fast solver process cap", () => {
  it("uses the three-process fast-stage default", () => {
    expect(progressiveFastSolverProcesses(96, "")).toBe(3);
  });

  it("allows an explicit eight-process fast-stage experiment", () => {
    expect(progressiveFastSolverProcesses(96, "8")).toBe(8);
  });

  it("clamps the experiment to eight processes", () => {
    expect(progressiveFastSolverProcesses(96, "64")).toBe(8);
  });

  it("falls back to three for malformed or non-positive values", () => {
    expect(progressiveFastSolverProcesses(96, "invalid")).toBe(3);
    expect(progressiveFastSolverProcesses(96, "0")).toBe(3);
  });

  it("never exceeds the available admission slots", () => {
    expect(progressiveFastSolverProcesses(3, "8")).toBe(3);
  });

  it("keeps the precise-stage fallback at four processes", () => {
    expect(progressiveSolverProcessesForStage(3, true, 96, null, "8")).toBe(4);
  });

  it("keeps steady jobs without a transient process override", () => {
    expect(
      progressiveSolverProcessesForStage(2, false, 96, null, "8"),
    ).toBeNull();
  });

  it("preserves an immutable configured process count", () => {
    expect(progressiveSolverProcessesForStage(2, true, 96, 6, "8")).toBe(6);
  });
});
