import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createClient } from "./client";
import { prepareMigrationSession } from "./migration-session";
import { prepareSolverEvidenceOwnerIndexes } from "./solver-evidence-owner-indexes";

const here = dirname(fileURLToPath(import.meta.url));
const { db, sql } = createClient({ max: 1 });

try {
  const ownership = await prepareSolverEvidenceOwnerIndexes(sql);
  if (process.argv.includes("--prepare-evidence-owner-indexes")) {
    console.log(JSON.stringify(ownership));
  } else {
    await prepareMigrationSession(sql);
    await migrate(db, { migrationsFolder: resolve(here, "../migrations") });
    console.log("✓ migrations applied");
  }
} finally {
  await sql.end();
}
