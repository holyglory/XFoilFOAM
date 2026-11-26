import { describe, expect, it } from "vitest";
import { progressiveUnsteadyRecipe } from "../src/progressive-cfd-numerical-recovery";

describe("bounded rhoPimpleFoam numerical recovery", () => {
  it("uses one conservative hard-solver retry and does not repeat it", () => {
    const recovery = progressiveUnsteadyRecipe(
      {
        selection: { solver: "rhoPimpleFoam", pressureKind: "absolute" },
        solver: { momentumScheme: "linearUpwind", transientMaxCourant: 4 },
      },
      "hard_solver",
    );

    expect(recovery).toMatchObject({
      selection: {
        solver: "rhoPimpleFoam",
        reason: "bounded_hard_solver_recovery",
      },
      solver: { momentumScheme: "upwind", transientMaxCourant: 0.2 },
    });
    expect(progressiveUnsteadyRecipe(recovery!, "hard_solver")).toBeNull();
  });
});
