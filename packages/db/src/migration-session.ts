import type { Sql } from "./client";

export const SOURCE_GEOMETRY_MIGRATION_BOUNDARY = 1792368000057;

export async function prepareMigrationSession(
  connection: Sql,
): Promise<boolean> {
  const [journal] =
    await connection`SELECT to_regclass('drizzle.__drizzle_migrations') AS relation`;
  const [latest] = journal.relation
    ? await connection`SELECT max(created_at) AS boundary FROM drizzle.__drizzle_migrations`
    : [{ boundary: null }];
  const boundary = Number(latest.boundary ?? 0);
  if (!Number.isSafeInteger(boundary) || boundary < 0)
    throw new Error("Invalid migration journal boundary");
  if (boundary >= SOURCE_GEOMETRY_MIGRATION_BOUNDARY) return false;
  await connection.unsafe("SET join_collapse_limit=1");
  await connection.unsafe("SET from_collapse_limit=1");
  await connection.unsafe("SET jit=off");
  await connection.unsafe("SET statement_timeout='120s'");
  return true;
}
