import type { EngineClient, EngineHealth } from "@aerodb/engine-client";

/** PostgreSQL `integer` is the durable storage boundary for an executed mesh
 * recovery strategy. Values outside this range are not capabilities we can
 * safely acknowledge or persist. */
export const MAX_MESH_RECOVERY_VERSION = 2_147_483_647;
export const MIN_DURABLE_URANS_RECOVERY_VERSION = 1;
export const MAX_URANS_RECOVERY_VERSION = 2_147_483_647;

export function parsedMeshRecoveryVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_MESH_RECOVERY_VERSION
    ? value
    : null;
}

export function parsedUransRecoveryVersion(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_URANS_RECOVERY_VERSION
    ? value
    : null;
}

async function engineHealthDetails(
  engine: EngineClient,
): Promise<EngineHealth | null> {
  const healthDetails = (
    engine as EngineClient & {
      healthDetails?: () => Promise<EngineHealth>;
    }
  ).healthDetails;
  if (typeof healthDetails !== "function") {
    return {
      status: "ok",
      version: "legacy-structural-test-double",
    };
  }
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
  return health as EngineHealth;
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
  const health = await engineHealthDetails(engine);
  if (!health) return null;
  if (!("mesh_recovery_version" in health)) return 0;
  return parsedMeshRecoveryVersion(health.mesh_recovery_version);
}

/** Read the live engine's durable cross-job URANS recovery contract.
 *
 * Missing is legacy version zero, including the production OpenCFD 2406
 * gateway which already advertises mesh-recovery v1. Unknown/malformed health
 * fails closed. Callers may continue ordinary RANS and initial URANS work, but
 * must not reopen or submit continuation/corrective-final recovery unless the
 * returned version is at least MIN_DURABLE_URANS_RECOVERY_VERSION.
 */
export async function engineUransRecoveryVersion(
  engine: EngineClient,
): Promise<number | null> {
  const health = await engineHealthDetails(engine);
  if (!health) return null;
  if (!("urans_recovery_version" in health)) return 0;
  return parsedUransRecoveryVersion(health.urans_recovery_version);
}

export function supportsDurableUransRecovery(
  version: number | null | undefined,
): version is number {
  return (
    version != null && version >= MIN_DURABLE_URANS_RECOVERY_VERSION
  );
}
