import { createClient } from "@aerodb/db";

// The API has ten query connections per process. Report imports can each hold
// a transaction while waiting on the same dispatch/campaign, so keep four
// connections available for public and admin requests throughout that wait.
const interactive = createClient({
  max: 4,
  connection: { application_name: "xfoilfoam-api-interactive" },
});
const sync = createClient({
  max: 6,
  connection: { application_name: "xfoilfoam-api-sync" },
});
export const db = interactive.db;
export const sql = interactive.sql;
export const syncDb = sync.db;
export const syncSql = sync.sql;

// Session advisory locks must never borrow from the query pool: an upload
// holds its lock while executing normal transactions, so sharing one bounded
// pool can self-deadlock when every connection becomes a lock holder.
const advisoryLockClient = createClient({
  max: 16,
  connection: { application_name: "xfoilfoam-api-advisory" },
});
export const advisoryLockSql = advisoryLockClient.sql;
export async function closeAdvisoryLockPool(): Promise<void> {
  await advisoryLockSql.end();
}
export async function closeDatabasePools(): Promise<void> {
  await Promise.all([advisoryLockSql.end(), syncSql.end(), sql.end()]);
}
