import { describe, expect, it } from "vitest";
import { progressiveRemoteExecutionSolverFamily } from "../src/progressive-remote-jobs";

describe("progressive remote execution solver family", () => {
  it.each([
    [2, "simpleFoam", "simpleFoam"],
    [2, "rhoSimpleFoam", "rhoSimpleFoam"],
    [3, "simpleFoam", "pimpleFoam"],
    [3, "rhoSimpleFoam", "rhoPimpleFoam"],
    [3, "pimpleFoam", "pimpleFoam"],
    [3, "rhoPimpleFoam", "rhoPimpleFoam"],
  ] as const)("maps stage %s %s to %s", (stage, configured, expected) => {
    expect(progressiveRemoteExecutionSolverFamily(stage, configured)).toBe(
      expected,
    );
  });
});
