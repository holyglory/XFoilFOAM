import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openFoamEngineIdentityFromConfig } from "@aerodb/engine-client";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  host: process.env.API_HOST ?? "0.0.0.0",
  engineUrl: process.env.ENGINE_URL ?? "http://localhost:8000",
  engineControlPlaneToken: process.env.ENGINE_CONTROL_PLANE_TOKEN ?? null,
  evidenceBucket: process.env.AIRFOILFOAM_EVIDENCE_BUCKET ?? null,
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
