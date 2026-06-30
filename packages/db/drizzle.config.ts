import { defineConfig } from "drizzle-kit";

import { DEFAULT_DATABASE_URL } from "./src/env";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL },
  verbose: true,
  strict: true,
});
