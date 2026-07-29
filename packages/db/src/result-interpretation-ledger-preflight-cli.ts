import { createClient } from "./client";
import { assertResultInterpretationLedgerMigrationPreflight } from "./result-interpretation-ledger-preflight";

const { db, sql } = createClient({ max: 1 });

await assertResultInterpretationLedgerMigrationPreflight(db);
await sql.end();
console.log("✓ result-interpretation ledger migration preflight passed");
