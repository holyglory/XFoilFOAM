import { solverExecutionPools, type DB } from "@aerodb/db";
import type { SimulationSetupSnapshot } from "@aerodb/db/simulation-setup";
import type { EngineIdentity } from "@aerodb/engine-client";
import { eq } from "drizzle-orm";

import { engineIdentityForSetup } from "./build-request";

/** Recover the immutable logical route stamped into every newly composed job.
 * Historical payloads without engine identity enter only the OpenCFD-v2406
 * compatibility path implemented by engineIdentityForSetup. */
export function expectedEngineForJob(job: {
  solverImplementationId?: string | null;
  requestPayload?: unknown;
}): EngineIdentity {
  const payload =
    job.requestPayload &&
    typeof job.requestPayload === "object" &&
    !Array.isArray(job.requestPayload)
      ? (job.requestPayload as Record<string, unknown>)
      : {};
  const setup = payload.setupSnapshot;
  if (!setup || typeof setup !== "object" || Array.isArray(setup)) {
    return engineIdentityForSetup({} as SimulationSetupSnapshot);
  }
  const snapshot = setup as SimulationSetupSnapshot;
  if (
    snapshot.engine &&
    job.solverImplementationId &&
    snapshot.engine.implementationId !== job.solverImplementationId
  ) {
    throw new Error(
      `sim job requested implementation ${job.solverImplementationId} but its immutable setup names ${snapshot.engine.implementationId}`,
    );
  }
  return engineIdentityForSetup(snapshot);
}

/** Resolve a persisted pool FK rather than trusting mutable/arbitrary request
 * JSON. Pre-migration jobs have no FK and remain on the historical `celery`
 * route only. */
export async function expectedExecutionPoolForJob(
  db: DB,
  job: {
    solverImplementationId?: string | null;
    solverExecutionPoolId?: string | null;
  },
): Promise<string> {
  if (!job.solverExecutionPoolId) return "celery";
  const [pool] = await db
    .select({
      solverImplementationId: solverExecutionPools.solverImplementationId,
      routingKey: solverExecutionPools.routingKey,
    })
    .from(solverExecutionPools)
    .where(eq(solverExecutionPools.id, job.solverExecutionPoolId))
    .limit(1);
  if (!pool) {
    throw new Error(
      `sim job execution pool ${job.solverExecutionPoolId} no longer exists`,
    );
  }
  if (
    job.solverImplementationId &&
    pool.solverImplementationId !== job.solverImplementationId
  ) {
    throw new Error(
      `sim job pool implementation ${pool.solverImplementationId} does not match requested ${job.solverImplementationId}`,
    );
  }
  return pool.routingKey;
}
