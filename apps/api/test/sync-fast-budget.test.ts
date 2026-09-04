import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { describe, expect, it } from "vitest";

import { mirroredSolverProfileValues } from "../src/sync-routes";

const solver = {
  id: "solver-profile",
  slug: "solver-profile",
  name: "Solver profile",
  turbulenceModel: "kOmegaSST",
  nIterations: 3000,
  convergenceTolerance: 1e-5,
  momentumScheme: "linearUpwind",
  transientCycles: 10,
  transientDiscardFraction: 0.4,
  transientMaxCourant: 4,
  uransPrecalcBudgetS: 28_800,
};

describe("mirrored experimental FAST solver configuration", () => {
  it("preserves the immutable budget with every numerical solver value", () => {
    const values = mirroredSolverProfileValues({
      solver,
    } as unknown as SimulationSetupSnapshot);
    expect(values).toEqual({
      turbulenceModel: "kOmegaSST",
      nIterations: 3000,
      convergenceTolerance: 1e-5,
      momentumScheme: "linearUpwind",
      transientCycles: 10,
      transientDiscardFraction: 0.4,
      transientMaxCourant: 4,
      uransPrecalcBudgetS: 28_800,
      uransInitializationIterations: null,
    });
  });

  it("keeps legacy/default snapshots unset instead of inventing a duration", () => {
    const values = mirroredSolverProfileValues({
      solver: { ...solver, uransPrecalcBudgetS: undefined },
    } as unknown as SimulationSetupSnapshot);
    expect(values.uransPrecalcBudgetS).toBeUndefined();
    expect(values.uransInitializationIterations).toBeNull();
  });

  it("preserves an explicitly pinned URANS initializer without changing primary RANS", () => {
    const values = mirroredSolverProfileValues({
      solver: { ...solver, uransInitializationIterations: 1200 },
    } as unknown as SimulationSetupSnapshot);
    expect(values.uransInitializationIterations).toBe(1200);
    expect(values.nIterations).toBe(3000);
  });
});
