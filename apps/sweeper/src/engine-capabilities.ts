import type { EngineClient, EngineHealth } from "@aerodb/engine-client";

/** PostgreSQL `integer` is the durable storage boundary for an executed mesh
 * recovery strategy. Values outside this range are not capabilities we can
 * safely acknowledge or persist. */
export const MAX_MESH_RECOVERY_VERSION = 2_147_483_647;

export function parsedMeshRecoveryVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_MESH_RECOVERY_VERSION
    ? value
    : null;
}

/** Read the live engine's monotonic PRECALC mesh-repair strategy version.
 *
 * A successful health response from a legacy engine has no field and is
 * therefore known version 0. A malformed response or failed round-trip is
 * unknown (`null`), which callers must treat as a closed scheduling gate: it
 * cannot authorize requeueing or stamp a newly-submitted PRECALC attempt.
 * Structural test engines predating healthDetails are intentionally legacy 0.
 */
export async function engineMeshRecoveryVersion(
  engine: EngineClient,
): Promise<number | null> {
  const healthDetails = (
    engine as EngineClient & {
      healthDetails?: () => Promise<EngineHealth>;
    }
  ).healthDetails;
  if (typeof healthDetails !== "function") return 0;
  let health: unknown;
  try {
    health = await healthDetails.call(engine);
  } catch {
    return null;
  }
  if (
    health === null ||
    typeof health !== "object" ||
    Array.isArray(health) ||
    !("status" in health) ||
    typeof health.status !== "string" ||
    !("version" in health) ||
    typeof health.version !== "string"
  ) {
    return null;
  }
  if (!("mesh_recovery_version" in health)) return 0;
  return parsedMeshRecoveryVersion(health.mesh_recovery_version);
}
