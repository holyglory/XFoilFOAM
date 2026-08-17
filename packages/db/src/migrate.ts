import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "./client";
import { migrateWithResultInterpretationLedgerPreflight } from "./result-interpretation-ledger-migration-runner";

const here = dirname(fileURLToPath(import.meta.url));
const { db, sql } = createClient({ max: 1 });

// Refuse an interrupted 0096–0106 footprint before Drizzle executes its one
// transaction. A clean pre-ledger production restore and a fully converged
// post-0106 database are both explicitly accepted.
await migrateWithResultInterpretationLedgerPreflight(
  db,
  resolve(here, "../migrations"),
);
await sql.end();
console.log("✓ migrations applied");
