import { describe, expect, it } from "vitest";
import { progressiveRemoteExecutionSolverFamily } from "../src/progressive-remote-jobs";

describe("progressive remote execution solver family", () => {
  it.each([
    ["simpleFoam", "simpleFoam"],
    ["rhoSimpleFoam", "rhoSimpleFoam"],
    ["pimpleFoam", "pimpleFoam"],
    ["rhoPimpleFoam", "rhoPimpleFoam"],
    ["rhoCentralFoam", "rhoCentralFoam"],
  ] as const)("retains the materialized %s request", (configured, expected) => {
    expect(progressiveRemoteExecutionSolverFamily(configured, expected)).toBe(
      expected,
    );
  });
  it.each([
    ["simpleFoam", "pimpleFoam"],
    ["rhoSimpleFoam", "rhoPimpleFoam"],
    ["rhoCentralFoam", "rhoPimpleFoam"],
    ["pimpleFoam", undefined],
  ] as const)("rejects an incompatible %s / %s request", (configured, requested) => {
    expect(() => progressiveRemoteExecutionSolverFamily(configured, requested))
      .toThrow("exact assigned request");
  });
});
