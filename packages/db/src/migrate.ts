import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createClient } from "./client";

const here = dirname(fileURLToPath(import.meta.url));
const { db, sql } = createClient({ max: 1 });

await migrate(db, { migrationsFolder: resolve(here, "../migrations") });
await sql.end();
console.log("✓ migrations applied");
