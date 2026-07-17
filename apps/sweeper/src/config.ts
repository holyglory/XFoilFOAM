import { createClient } from "@aerodb/db";
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

export function configuredEvidenceCleanupTimeoutMs(): number {
  const gcsTimeoutSeconds = Number(
    process.env.AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS ?? 900,
  );
  const minimum = gcsTimeoutSeconds * 1_000 + 60_000;
  const configured = Number(
    process.env.ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS ?? minimum,
  );
  if (
    !Number.isSafeInteger(gcsTimeoutSeconds) ||
    gcsTimeoutSeconds < 30 ||
    !Number.isSafeInteger(configured) ||
    configured < minimum
  ) {
    throw new Error(
      "ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS must be an integer at least 60 seconds above AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS",
    );
  }
  return configured;
}

export function makeContext() {
  const { db, sql } = createClient({ max: 4 });
  const engine = new EngineClient(
    process.env.ENGINE_URL ?? "http://localhost:8000",
    {
      expectedEngine: configuredEngineIdentity(),
      controlPlaneToken: configuredControlPlaneToken(),
      evidenceCleanupTimeoutMs: configuredEvidenceCleanupTimeoutMs(),
    },
  );
  return { db, sql, engine };
}
