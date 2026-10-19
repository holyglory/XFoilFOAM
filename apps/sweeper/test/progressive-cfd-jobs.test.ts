import { describe, expect, it } from "vitest";

import {
  progressiveFastSolverProcesses,
  progressivePreciseSolverProcesses,
  progressiveSolverProcessesForStage,
} from "../src/progressive-cfd-jobs";

describe("progressive fast solver process cap", () => {
  it("keeps the existing four-process default", () => {
    expect(progressiveFastSolverProcesses(96, "")).toBe(4);
  });

  it("allows an explicit eight-process fast-stage experiment", () => {
    expect(progressiveFastSolverProcesses(96, "8")).toBe(8);
  });

  it("clamps the experiment to eight processes", () => {
    expect(progressiveFastSolverProcesses(96, "64")).toBe(8);
  });

  it("falls back to four for malformed or non-positive values", () => {
    expect(progressiveFastSolverProcesses(96, "invalid")).toBe(4);
    expect(progressiveFastSolverProcesses(96, "0")).toBe(4);
  });

  it("never exceeds the available admission slots", () => {
    expect(progressiveFastSolverProcesses(3, "8")).toBe(3);
  });

  it("keeps the precise-stage fallback at four processes", () => {
    expect(progressiveSolverProcessesForStage(3, true, 96, null, "8")).toBe(4);
  });

  it("allows a bounded eight-process precise-stage benchmark", () => {
    expect(progressivePreciseSolverProcesses(96, "8")).toBe(8);
    expect(
      progressiveSolverProcessesForStage(3, true, 96, null, "", "8"),
    ).toBe(8);
  });

  it("clamps precise-stage process requests to available slots and eight", () => {
    expect(progressivePreciseSolverProcesses(3, "8")).toBe(3);
    expect(progressivePreciseSolverProcesses(96, "64")).toBe(8);
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
