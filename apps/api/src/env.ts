import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  host: process.env.API_HOST ?? "0.0.0.0",
  engineUrl: process.env.ENGINE_URL ?? "http://localhost:8000",
  engineExpectedBuildId: process.env.ENGINE_EXPECTED_BUILD_ID ?? process.env.AIRFOILFOAM_BUILD_ID ?? null,
  mediaDir: process.env.MEDIA_DIR ?? "/data/airfoilfoam",
};
