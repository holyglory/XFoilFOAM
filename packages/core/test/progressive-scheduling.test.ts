import { describe, expect, it } from "vitest";
import {
  initialFastAnchors,
  nextFastAnchor,
  selectProgressiveSolver,
  progressiveSolverIsTransient,
} from "../src/progressive-scheduling";

describe("immutable progressive time-coordinate semantics", () => {
  it("preserves legacy physical-time density execution and explicitly selects local steady iterations", () => {
    expect(progressiveSolverIsTransient("rhoCentralFoam")).toBe(true);
    expect(
      progressiveSolverIsTransient("rhoCentralFoam", "physical_time_seconds"),
    ).toBe(true);
    expect(
      progressiveSolverIsTransient(
        "rhoCentralFoam",
        "local_pseudo_time_iterations",
      ),
    ).toBe(false);
    expect(progressiveSolverIsTransient("rhoSimpleFoam")).toBe(false);
  });
  it("rejects incompatible or unknown numerical time coordinates", () => {
    expect(() =>
      progressiveSolverIsTransient(
        "rhoSimpleFoam",
        "local_pseudo_time_iterations",
      ),
    ).toThrow("density-based");
    expect(() =>
      progressiveSolverIsTransient("simpleFoam", "physical_time_seconds"),
    ).toThrow("physical-time");
    expect(() =>
      progressiveSolverIsTransient("rhoCentralFoam", "unknown" as never),
    ).toThrow("Unknown");
  });
});

describe("progressive solver routing", () => {
  const steady = {
    minimumCriticalMach: 0.7,
    diagnosedUnsteadiness: false,
    diagnosedShockInstability: false,
  };
  it("uses incompressible solvers only with both low free-stream Mach and sonic margin", () => {
    expect(selectProgressiveSolver({ ...steady, mach: 0.2 }).solver).toBe(
      "simpleFoam",
    );
    expect(
      selectProgressiveSolver({
        ...steady,
        mach: 0.2,
        minimumCriticalMach: null,
      }).solver,
    ).toBe("rhoSimpleFoam");
    expect(
      selectProgressiveSolver({
        ...steady,
        mach: 0.2,
        minimumCriticalMach: 0.23,
      }).solver,
    ).toBe("rhoSimpleFoam");
    expect(selectProgressiveSolver({ ...steady, mach: 0.3 }).pressureKind).toBe(
      "absolute",
    );
  });
  it("routes transonic and supersonic boundaries explicitly", () => {
    expect(selectProgressiveSolver({ ...steady, mach: 0.85 }).solver).toBe(
      "rhoSimpleFoam",
    );
    expect(selectProgressiveSolver({ ...steady, mach: 1.199 }).solver).toBe(
      "rhoSimpleFoam",
    );
    for (const mach of [1.2, 2, 3])
      expect(selectProgressiveSolver({ ...steady, mach }).solver).toBe(
        "rhoCentralFoam",
      );
    for (const mach of [-1, 3.001, NaN, Infinity])
      expect(() => selectProgressiveSolver({ ...steady, mach })).toThrow();
  });
  it("requires diagnosed unsteadiness or shock instability for transient fallback", () => {
    expect(
      selectProgressiveSolver({
        ...steady,
        mach: 0.2,
        diagnosedUnsteadiness: true,
      }).solver,
    ).toBe("pimpleFoam");
    expect(
      selectProgressiveSolver({
        ...steady,
        mach: 0.8,
        diagnosedUnsteadiness: true,
      }).solver,
    ).toBe("rhoPimpleFoam");
    expect(
      selectProgressiveSolver({
        ...steady,
        mach: 0.2,
        diagnosedShockInstability: true,
      }).solver,
    ).toBe("rhoPimpleFoam");
  });
});

describe("fast polar coverage", () => {
  const angles = [-4, -2, 0, 2, 4, 6, 8, 10, 12];
  const prediction = angles.map((alpha) => ({
    alpha,
    cl: 0.1 * (alpha + 1),
    cd: 0.01 + 0.001 * (alpha - 2) ** 2,
  }));
  it("snaps zero lift and best efficiency to two distinct requested angles", () => {
    expect(initialFastAnchors(angles, prediction)).toEqual({
      angles: [-2, 4],
      reason: "prior_zero_lift_and_efficiency",
    });
  });
  it("uses actual scope bracketing without inventing a missing prediction", () => {
    expect(initialFastAnchors(angles, null)).toEqual({
      angles: [-4, 12],
      reason: "missing_prior_bracketing",
    });
    expect(initialFastAnchors([2], null).angles).toEqual([2]);
  });
  it("keeps two anchors distinct for degenerate or no-zero-lift curves", () => {
    expect(
      new Set(
        initialFastAnchors(
          angles,
          prediction.map((sample) => ({ ...sample, cl: 1, cd: 1 })),
        ).angles,
      ).size,
    ).toBe(2);
    expect(() =>
      initialFastAnchors(
        angles,
        prediction.map((sample) => ({ ...sample, cd: -1 })),
      ),
    ).toThrow();
    expect(() => initialFastAnchors(angles, prediction.slice(1))).toThrow();
  });
  const candidate = (alpha: number, gain = 0.1, cost = 60) => ({
    alpha,
    integratedVarianceReductionFraction: gain,
    expectedActiveSeconds: cost,
    modelId: "model",
    costEvidenceId: "real-cost",
  });
  const input = {
    requestedAngles: angles,
    attemptedAngles: [-2, 4],
    initialCoverageComplete: true,
    candidates: [candidate(6)],
  };
  it("keeps extras behind every target's initial coverage and a finite angle budget", () => {
    expect(
      nextFastAnchor({ ...input, initialCoverageComplete: false }).reason,
    ).toBe("initial_coverage_pending");
    expect(
      nextFastAnchor({ ...input, attemptedAngles: angles.slice(0, 8) }).reason,
    ).toBe("angle_budget");
  });
  it("uses normalized information per measured cost and an inclusive gain threshold", () => {
    expect(
      nextFastAnchor({
        ...input,
        candidates: [candidate(6, 0.2, 100), candidate(8, 0.1, 20)],
      }).alpha,
    ).toBe(8);
    expect(
      nextFastAnchor({ ...input, candidates: [candidate(6, 0.049)] }).reason,
    ).toBe("marginal_gain");
    expect(
      nextFastAnchor({ ...input, candidates: [candidate(6, 0.05)] }).alpha,
    ).toBe(6);
    expect(nextFastAnchor({ ...input, candidates: [] }).reason).toBe(
      "no_measured_candidate",
    );
    expect(() =>
      nextFastAnchor({
        ...input,
        candidates: [{ ...candidate(6), costEvidenceId: "" }],
      }),
    ).toThrow();
  });
});
