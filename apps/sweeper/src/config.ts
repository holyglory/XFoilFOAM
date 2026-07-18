import { createClient } from "@aerodb/db";
import { canonicalRemoteHubBaseUrl } from "@aerodb/core";
import {
  EngineClient,
  openFoamEngineIdentityFromConfig,
} from "@aerodb/engine-client";

export function configuredEngineIdentity() {
  return openFoamEngineIdentityFromConfig({
    distribution:
      process.env.ENGINE_DISTRIBUTION ?? process.env.OPENFOAM_DISTRIBUTION,
    version: process.env.ENGINE_VERSION ?? process.env.OPENFOAM_VERSION,
    numericsRevision: process.env.ENGINE_NUMERICS_REVISION,
    adapterContractVersion: process.env.ENGINE_ADAPTER_CONTRACT_VERSION,
  });
}

export function configuredControlPlaneToken(): string | undefined {
  const token = process.env.ENGINE_CONTROL_PLANE_TOKEN?.trim();
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim();
  const remoteOnly = /^(?:1|true|yes|on)$/i.test(
    process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY?.trim() ?? "",
  );
  if (bucket && remoteOnly && (!token || token.length < 32)) {
    throw new Error(
      "ENGINE_CONTROL_PLANE_TOKEN (at least 32 characters) is required when remote-only GCS evidence is enabled",
    );
  }
  return token || undefined;
}

/**
 * Remote solver nodes upload their local engine bundle through a hub-issued
 * resumable capability. They deliberately have no GCS identity of their own,
 * so the engine must retain the local tar.zst until the sweeper has uploaded
 * and the hub has independently verified it.
 */
export function assertRemoteSolverNodeEvidenceContract(
  remoteSolverEnabled: boolean,
): void {
  if (!remoteSolverEnabled) return;
  const bucket = process.env.AIRFOILFOAM_EVIDENCE_BUCKET?.trim() ?? "";
  const remoteOnly = /^(?:1|true|yes|on)$/i.test(
    process.env.AIRFOILFOAM_EVIDENCE_REMOTE_ONLY?.trim() ?? "",
  );
  if (bucket || remoteOnly) {
    throw new Error(
      "remote solver evidence configuration is unsafe: credentialless remote nodes require AIRFOILFOAM_EVIDENCE_BUCKET empty and AIRFOILFOAM_EVIDENCE_REMOTE_ONLY=false so the local tar.zst survives for hub-brokered upload",
    );
  }
  const controlToken = process.env.ENGINE_CONTROL_PLANE_TOKEN?.trim();
  if (!controlToken || controlToken.length < 32) {
    throw new Error(
      "remote solver evidence configuration is incomplete: ENGINE_CONTROL_PLANE_TOKEN (at least 32 characters) is required for authenticated crash-safe local reclaim",
    );
  }
}

/** Fail closed on an unsafe persisted authority before the sweeper can make
 * any registration, claim, delivery, reclaim, or cancellation request. */
export function assertRemoteSolverHubUrlContract(
  upstreamBaseUrl: string | null | undefined,
): string | null {
  if (upstreamBaseUrl == null) return null;
  return canonicalRemoteHubBaseUrl(upstreamBaseUrl);
}

export function makeContext() {
  const { db, sql } = createClient({ max: 4 });
  const engine = new EngineClient(
    process.env.ENGINE_URL ?? "http://localhost:8000",
    {
      expectedEngine: configuredEngineIdentity(),
      controlPlaneToken: configuredControlPlaneToken(),
    },
  );
  return { db, sql, engine };
}
