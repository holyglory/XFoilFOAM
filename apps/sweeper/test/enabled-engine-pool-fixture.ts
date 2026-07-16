import type { DB } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { vi } from "vitest";

import type { ResolvedSolverExecutionPool } from "../src/engine-pool";

/**
 * OpenCFD 2606 is deliberately seeded disabled until the production canary
 * completes. Sweeper lifecycle suites need deterministic admission without
 * flipping that shared database switch, so they opt into this identity-aware
 * resolver fixture. Engine-pool contract tests intentionally do not import it.
 */
vi.mock("../src/engine-pool", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/engine-pool")>();
  const {
    FOUNDATION_14_EXECUTION_POOL_ID,
    FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
    OPENCFD_2406_EXECUTION_POOL_ID,
    OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
    OPENCFD_2606_EXECUTION_POOL_ID,
    OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
  } = await import("@aerodb/db");

  const pools: Readonly<Record<string, ResolvedSolverExecutionPool>> = {
    [OPENCFD_2406_SOLVER_IMPLEMENTATION_ID]: {
      id: OPENCFD_2406_EXECUTION_POOL_ID,
      solverImplementationId: OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
      routingKey: "celery",
      capacityKind: "cpu_slots",
      capacityLimit: null,
    },
    [OPENCFD_2606_SOLVER_IMPLEMENTATION_ID]: {
      id: OPENCFD_2606_EXECUTION_POOL_ID,
      solverImplementationId: OPENCFD_2606_SOLVER_IMPLEMENTATION_ID,
      routingKey: "openfoam-opencfd-2606",
      capacityKind: "cpu_slots",
      capacityLimit: null,
    },
    [FOUNDATION_14_SOLVER_IMPLEMENTATION_ID]: {
      id: FOUNDATION_14_EXECUTION_POOL_ID,
      solverImplementationId: FOUNDATION_14_SOLVER_IMPLEMENTATION_ID,
      routingKey: "openfoam-foundation-14",
      capacityKind: "cpu_slots",
      capacityLimit: null,
    },
  };

  return {
    ...actual,
    requireExecutionPoolForSetup: async (
      _db: DB,
      setup: SimulationSetupSnapshot,
    ): Promise<ResolvedSolverExecutionPool> => {
      const solverImplementationId =
        setup.engine?.implementationId ?? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID;
      const pool = pools[solverImplementationId];
      if (!pool) {
        throw new actual.SolverExecutionPoolUnavailableError(
          solverImplementationId,
          "no enabled execution pool in test fixture",
        );
      }
      return { ...pool };
    },
  };
});
