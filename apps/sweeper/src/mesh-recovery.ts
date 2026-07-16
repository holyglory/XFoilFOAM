import {
  type DB,
  type MeshRecoveryRequeueScope,
  requeueDeterministicMeshObligationsForRecoveryVersion,
  requeueDeterministicRansMeshFailuresForRecoveryVersion,
} from "@aerodb/db";
import type { EngineClient } from "@aerodb/engine-client";

import { engineMeshRecoveryVersion } from "./engine-capabilities";

/** One bounded control-plane preparation pass before scheduler lane choice.
 * It learns the live engine capability, reopens only older structured
 * deterministic-mesh obligations with a remaining attempt, refreshes campaign
 * counters, and returns the exact version every resulting PRECALC job must
 * stamp into requestPayload. */
export async function prepareAutomaticMeshRecovery(
  db: DB,
  engine: EngineClient,
  scope: MeshRecoveryRequeueScope = {},
): Promise<number | null> {
  const meshRecoveryVersion = await engineMeshRecoveryVersion(engine);
  if (meshRecoveryVersion == null) {
    console.error(
      "[sweeper] PRECALC scheduling deferred: engine mesh-recovery capability is unavailable or malformed",
    );
    return null;
  }
  const reopened = await requeueDeterministicMeshObligationsForRecoveryVersion(
    db,
    meshRecoveryVersion,
    scope,
  );
  if (reopened.obligationIds.length) {
    console.log(
      `[sweeper] reopened ${reopened.obligationIds.length} deterministic PRECALC mesh obligation(s) for engine mesh recovery strategy v${meshRecoveryVersion}; original attempt evidence retained`,
    );
  }
  const ransScope =
    scope.campaignIds !== undefined
      ? { campaignIds: scope.campaignIds }
      : Object.keys(scope).length
        ? { resultIds: [] }
        : {};
  const reopenedRans =
    await requeueDeterministicRansMeshFailuresForRecoveryVersion(
      db,
      meshRecoveryVersion,
      ransScope,
    );
  if (reopenedRans.resultIds.length) {
    console.log(
      `[sweeper] reopened ${reopenedRans.resultIds.length} deterministic wave-1 RANS mesh result(s) for engine mesh recovery strategy v${meshRecoveryVersion}; original attempt evidence retained`,
    );
  }
  return meshRecoveryVersion;
}
