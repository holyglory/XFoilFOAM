import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Load the repo-root .env (packages/db/src → ../../../.env). Does not override
// variables already present in the environment (compose sets them directly).
const here = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(here, "../../../.env") });

export const DEFAULT_DATABASE_URL = "postgres://aerodb:aerodb@localhost:5432/aerodb";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
