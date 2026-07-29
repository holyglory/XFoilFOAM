import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createClient } from "./client";
import { migrateWithResultInterpretationLedgerPreflight } from "./result-interpretation-ledger-migration-runner";

const here = dirname(fileURLToPath(import.meta.url));
const { db, sql } = createClient({ max: 1 });

// Refuse an interrupted 0096–0099 footprint before Drizzle executes its one
// transaction. A clean pre-ledger production restore and a fully converged
// post-0099 database are both explicitly accepted.
await migrateWithResultInterpretationLedgerPreflight(
  db,
  resolve(here, "../migrations"),
);
await sql.end();
console.log("✓ migrations applied");
