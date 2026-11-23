import type postgres from "postgres";
import type { Sql } from "./client";

export interface NonNullIndex {
  table: string;
  column: string;
  name: string;
}
type IndexAction = { name: string; action: "existing" | "created" | "rebuilt" };

async function inspect(
  session: postgres.ReservedSql,
  name: string,
  definition: string,
) {
  const [index] =
    await session`SELECT CASE WHEN c.relkind='i' THEN pg_catalog.pg_get_indexdef(c.oid) END AS definition,
      i.indisvalid AND i.indisready AND i.indislive AS usable,
      i.indisreplident OR i.indisclustered OR i.indisexclusion OR EXISTS
        (SELECT FROM pg_catalog.pg_constraint k WHERE k.conindid=c.oid) AS protected
    FROM pg_catalog.pg_class c LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.oid
    WHERE c.relnamespace='public'::regnamespace AND c.relname=${name}`;
  if (index && (index.definition !== definition || index.protected))
    throw new Error(
      `Existing public.${name} differs from required index definition`,
    );
  return index;
}

/** Use one autocommit backend, including the family lock. Only repair an
 * invalid index whose complete catalog definition belongs to this family. */
export async function prepareNonNullIndexes(
  sql: Sql,
  migration: number,
  specs: readonly NonNullIndex[],
) {
  const session = await sql.reserve();
  const indexes: IndexAction[] = [];
  let locked = false,
    tablePresent = false;
  try {
    await session`SELECT pg_advisory_lock(${migration}::int,1)`;
    locked = true;
    for (const { table, column, name } of specs) {
      if (![table, column, name].every((s) => /^[a-z][a-z0-9_]{0,62}$/.test(s)))
        throw new Error("Invalid migration index identifier");
      const target = "public." + table;
      const [catalog] =
        await session`SELECT to_regclass(${target}) IS NOT NULL AS present`;
      if (!catalog.present) continue;
      tablePresent = true;
      const suffix = ` ON ${target} USING btree (${column}) WHERE (${column} IS NOT NULL)`;
      const expected = "CREATE INDEX " + name + suffix;
      const index = await inspect(session, name, expected);
      if (index?.usable) {
        indexes.push({ name, action: "existing" });
        continue;
      }
      const [work] =
        await session`SELECT EXISTS(SELECT FROM pg_catalog.pg_stat_progress_create_index WHERE relid=to_regclass(${target})) AS active`;
      if (work.active)
        throw new Error(`Index maintenance is still active on ${target}`);
      if (index) await session.unsafe("DROP INDEX CONCURRENTLY public." + name);
      await session.unsafe("CREATE INDEX CONCURRENTLY " + name + suffix);
      if (!(await inspect(session, name, expected))?.usable)
        throw new Error(`Index public.${name} did not become usable`);
      indexes.push({ name, action: index ? "rebuilt" : "created" });
    }
    return { tablePresent, indexes };
  } finally {
    try {
      if (locked) await session`SELECT pg_advisory_unlock(${migration}::int,1)`;
    } finally {
      session.release();
    }
  }
}
