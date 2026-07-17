import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openFoamEngineIdentityFromConfig } from "@aerodb/engine-client";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

const evidenceGcsTimeoutSeconds = Number(
  process.env.AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS ?? 900,
);
const minimumEvidenceCleanupTimeoutMs =
  evidenceGcsTimeoutSeconds * 1_000 + 60_000;
const engineEvidenceCleanupTimeoutMs = Number(
  process.env.ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS ??
    minimumEvidenceCleanupTimeoutMs,
);
if (
  !Number.isSafeInteger(evidenceGcsTimeoutSeconds) ||
  evidenceGcsTimeoutSeconds < 30 ||
  !Number.isSafeInteger(engineEvidenceCleanupTimeoutMs) ||
  engineEvidenceCleanupTimeoutMs < minimumEvidenceCleanupTimeoutMs
) {
  throw new Error(
    "ENGINE_EVIDENCE_CLEANUP_TIMEOUT_MS must be an integer at least 60 seconds above AIRFOILFOAM_EVIDENCE_GCS_TIMEOUT_SECONDS",
  );
}

export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  host: process.env.API_HOST ?? "0.0.0.0",
  engineUrl: process.env.ENGINE_URL ?? "http://localhost:8000",
  engineControlPlaneToken:
    process.env.ENGINE_CONTROL_PLANE_TOKEN?.trim() || null,
  engineEvidenceCleanupTimeoutMs,
  engineExpectedBuildId:
    process.env.ENGINE_EXPECTED_BUILD_ID ??
    process.env.AIRFOILFOAM_BUILD_ID ??
    null,
  mediaDir: process.env.MEDIA_DIR ?? "/data/airfoilfoam",
  engineIdentity: openFoamEngineIdentityFromConfig({
    distribution:
      process.env.ENGINE_DISTRIBUTION ?? process.env.OPENFOAM_DISTRIBUTION,
    version: process.env.ENGINE_VERSION ?? process.env.OPENFOAM_VERSION,
    numericsRevision: process.env.ENGINE_NUMERICS_REVISION,
    adapterContractVersion: process.env.ENGINE_ADAPTER_CONTRACT_VERSION,
  }),
};
