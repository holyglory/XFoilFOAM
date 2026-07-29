import { migrate } from "drizzle-orm/postgres-js/migrator";

import type { DB } from "./client";
import { assertResultInterpretationLedgerMigrationPreflight } from "./result-interpretation-ledger-preflight";

/**
 * The one migration path used by the production CLI and the disposable-DB
 * release test.  Keeping the fail-closed gate here prevents a future CLI
 * refactor from applying 0094–0099 before the exact journal/schema baseline
 * has been read and accepted.
 */
export async function migrateWithResultInterpretationLedgerPreflight(
  db: DB,
  migrationsFolder: string,
): Promise<void> {
  await assertResultInterpretationLedgerMigrationPreflight(db);
  await migrate(db, { migrationsFolder });
  await assertResultInterpretationLedgerMigrationPreflight(db);
}
