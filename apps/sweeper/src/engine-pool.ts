import {
  OPENCFD_2406_SOLVER_IMPLEMENTATION_ID,
  solverExecutionPools,
  type DB,
} from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import { and, asc, eq } from "drizzle-orm";

export class SolverExecutionPoolUnavailableError extends Error {
  readonly code = "engine_pool_unavailable";
  constructor(
    readonly solverImplementationId: string,
    detail: string,
  ) {
    super(`engine pool unavailable for ${solverImplementationId}: ${detail}`);
    this.name = "SolverExecutionPoolUnavailableError";
  }
}

export interface ResolvedSolverExecutionPool {
  id: string;
  solverImplementationId: string;
  routingKey: string;
  capacityKind: string;
  capacityLimit: number | null;
}

/** Admission/routing truth for newly composed jobs. Exactly one enabled pool
 * must own the immutable setup implementation; zero is disabled/unavailable,
 * and multiple is ambiguous configuration. Existing submitted jobs retain
 * their stamped pool and are never re-routed by this resolver. */
export async function requireExecutionPoolForSetup(
  db: DB,
  setup: SimulationSetupSnapshot,
): Promise<ResolvedSolverExecutionPool> {
  const solverImplementationId =
    setup.engine?.implementationId ?? OPENCFD_2406_SOLVER_IMPLEMENTATION_ID;
  const pools = await db
    .select({
      id: solverExecutionPools.id,
      solverImplementationId: solverExecutionPools.solverImplementationId,
      routingKey: solverExecutionPools.routingKey,
      capacityKind: solverExecutionPools.capacityKind,
      capacityLimit: solverExecutionPools.capacityLimit,
    })
    .from(solverExecutionPools)
    .where(
      and(
        eq(solverExecutionPools.solverImplementationId, solverImplementationId),
        eq(solverExecutionPools.enabled, true),
      ),
    )
    .orderBy(asc(solverExecutionPools.id));
  if (pools.length === 0) {
    throw new SolverExecutionPoolUnavailableError(
      solverImplementationId,
      "no enabled execution pool",
    );
  }
  if (pools.length > 1) {
    throw new SolverExecutionPoolUnavailableError(
      solverImplementationId,
      `ambiguous routing (${pools.length} enabled pools)`,
    );
  }
  if (!pools[0].routingKey.trim()) {
    throw new SolverExecutionPoolUnavailableError(
      solverImplementationId,
      "enabled pool has an empty routing key",
    );
  }
  return pools[0];
}
