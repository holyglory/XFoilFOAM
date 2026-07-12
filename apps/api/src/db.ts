import { createClient } from "@aerodb/db";

// One pool for the lifetime of the server process.
const client = createClient({ max: 10 });
export const db = client.db;
export const sql = client.sql;

// Session advisory locks must never borrow from the query pool: an upload
// holds its lock while executing normal transactions, so sharing one bounded
// pool can self-deadlock when every connection becomes a lock holder.
const advisoryLockClient = createClient({ max: 16 });
export const advisoryLockSql = advisoryLockClient.sql;
export async function closeAdvisoryLockPool(): Promise<void> {
  await advisoryLockSql.end();
}
export async function closeDatabasePools(): Promise<void> {
  await Promise.all([advisoryLockSql.end(), sql.end()]);
}
